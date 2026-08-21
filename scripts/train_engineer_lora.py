"""
Fine-tune Qwen2.5-Coder-7B-Instruct with LoRA for Anthos Engineer.

Run this on RunPod (A100/H100) or your DGX Spark — NOT on the MacBook.

Setup (RunPod):
    pip install "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git"
    pip install trl datasets

Usage:
    python scripts/train_engineer_lora.py
    python scripts/train_engineer_lora.py --data data/engineer_train.jsonl --steps 300

After training, export to Ollama:
    python scripts/train_engineer_lora.py --export-only
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


BASE_MODEL = "unsloth/Qwen2.5-Coder-7B-Instruct-bnb-4bit"
OUTPUT_DIR = "checkpoints/anthos-engineer-lora"
MERGED_DIR = "checkpoints/anthos-engineer-merged"
GGUF_PATH  = "checkpoints/anthos-engineer-coder-q4.gguf"
MODELFILE   = "Modelfile.engineer"

MAX_SEQ_LEN = 2048
LORA_RANK   = 16
LORA_ALPHA  = 32


def load_dataset(path: str):
    from datasets import Dataset

    records = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return Dataset.from_list(records)


def format_example(example: dict, tokenizer) -> dict:
    text = tokenizer.apply_chat_template(
        example["messages"],
        tokenize=False,
        add_generation_prompt=False,
    )
    return {"text": text}


def train(data_path: str, max_steps: int) -> None:
    try:
        from unsloth import FastLanguageModel
        from trl import SFTTrainer, SFTConfig
        from datasets import Dataset
    except ImportError:
        print("ERROR: unsloth and trl must be installed.")
        print("  pip install 'unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git' trl datasets")
        sys.exit(1)

    print(f"Loading base model: {BASE_MODEL}")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=BASE_MODEL,
        max_seq_length=MAX_SEQ_LEN,
        load_in_4bit=True,
        dtype=None,  # auto-detect
    )

    model = FastLanguageModel.get_peft_model(
        model,
        r=LORA_RANK,
        lora_alpha=LORA_ALPHA,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
        lora_dropout=0,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=42,
    )

    print(f"Loading dataset: {data_path}")
    raw = load_dataset(data_path)
    dataset = raw.map(lambda ex: format_example(ex, tokenizer))

    # 90/10 train/eval split
    split = dataset.train_test_split(test_size=0.1, seed=42)

    print(f"Training on {len(split['train'])} examples, eval on {len(split['test'])}")

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=split["train"],
        eval_dataset=split["test"],
        args=SFTConfig(
            output_dir=OUTPUT_DIR,
            dataset_text_field="text",
            max_seq_length=MAX_SEQ_LEN,
            per_device_train_batch_size=4,
            gradient_accumulation_steps=4,
            warmup_steps=20,
            max_steps=max_steps,
            learning_rate=2e-4,
            fp16=not _has_bf16(),
            bf16=_has_bf16(),
            logging_steps=10,
            evaluation_strategy="steps",
            eval_steps=50,
            save_strategy="steps",
            save_steps=100,
            optim="adamw_8bit",
            weight_decay=0.01,
            lr_scheduler_type="cosine",
            seed=42,
            report_to="none",
        ),
    )

    print("Starting training...")
    trainer.train()

    print(f"Saving LoRA adapter → {OUTPUT_DIR}")
    model.save_pretrained(OUTPUT_DIR)
    tokenizer.save_pretrained(OUTPUT_DIR)
    print("Training complete.")


def export_gguf() -> None:
    """Merge LoRA → full weights → quantize to GGUF → register with Ollama."""
    try:
        from unsloth import FastLanguageModel
    except ImportError:
        print("ERROR: unsloth required for export.")
        sys.exit(1)

    print(f"Loading LoRA from {OUTPUT_DIR} for merge...")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=OUTPUT_DIR,
        max_seq_length=MAX_SEQ_LEN,
        load_in_4bit=True,
    )

    print(f"Merging and saving full weights → {MERGED_DIR}")
    model.save_pretrained_merged(MERGED_DIR, tokenizer, save_method="merged_16bit")

    print(f"Quantizing to GGUF (Q4_K_M) → {GGUF_PATH}")
    model.save_pretrained_gguf(
        GGUF_PATH.replace(".gguf", ""),
        tokenizer,
        quantization_method="q4_k_m",
    )

    _write_modelfile()
    _register_ollama()


def _write_modelfile() -> None:
    gguf_abs = str(Path(GGUF_PATH).resolve())
    content = f"""\
FROM {gguf_abs}

SYSTEM \"\"\"You are Anthos Engineer, an expert agentic coding system built by Brian Tushae Thomas.
You plan, write, and execute code to accomplish user goals.
You produce clean, production-ready Python unless another language is specified.
When asked to classify intent, reply with exactly one word: build or chat.
When asked to plan, reply with ONLY a valid JSON array.
When asked to write code, reply with ONLY the code, no markdown fences.\"\"\"

PARAMETER temperature 0.2
PARAMETER top_p 0.9
PARAMETER repeat_penalty 1.1
PARAMETER num_ctx {MAX_SEQ_LEN}
"""
    Path(MODELFILE).write_text(content)
    print(f"Wrote {MODELFILE}")


def _register_ollama() -> None:
    model_name = "anthos-engineer-coder"
    print(f"Registering with Ollama as '{model_name}'...")
    result = subprocess.run(
        ["ollama", "create", model_name, "-f", MODELFILE],
        capture_output=True, text=True,
    )
    if result.returncode == 0:
        print(f"Success. Test it with:")
        print(f"  ollama run {model_name} 'build a hello world FastAPI app'")
        print(f"\nOr in Anthos Engineer:")
        print(f"  ANTHOS_MODEL={model_name} anthos-engineer")
    else:
        print(f"Ollama registration failed:\n{result.stderr}")
        print(f"Run manually: ollama create {model_name} -f {MODELFILE}")


def _has_bf16() -> bool:
    try:
        import torch
        return torch.cuda.is_bf16_supported()
    except Exception:
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Train Anthos Engineer LoRA")
    parser.add_argument("--data", default="data/engineer_train.jsonl", help="Training data JSONL")
    parser.add_argument("--steps", type=int, default=200, help="Max training steps")
    parser.add_argument("--export-only", action="store_true", help="Skip training, just export to Ollama")
    args = parser.parse_args()

    if args.export_only:
        export_gguf()
        return

    if not Path(args.data).exists():
        print(f"Data file not found: {args.data}")
        print("Generate it first:")
        print("  python scripts/generate_engineer_data.py")
        sys.exit(1)

    train(args.data, args.steps)
    export_gguf()


if __name__ == "__main__":
    main()
