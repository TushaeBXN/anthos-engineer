import { Project, SyntaxKind } from "ts-morph";
import path from "node:path";
import type { SystemNode, SystemEdge } from "../schema.js";
import type { Extractor, ExtractionResult } from "../extractor.js";

function moduleId(filePath: string): string {
  return `module:${filePath}`;
}

function functionId(filePath: string, name: string): string {
  return `function:${filePath}:${name}`;
}

function depId(specifier: string): string {
  return `dep:${specifier}`;
}

function edgeId(fromId: string, kind: string, toId: string): string {
  return `${fromId}->${kind}->${toId}`;
}

export class TypeScriptExtractor implements Extractor {
  readonly id = "ts-extractor";
  readonly version = "1.0.0";
  readonly extensions = [".ts", ".tsx", ".mts", ".cts"];

  private project = new Project({
    compilerOptions: {
      allowJs: true,
      resolveJsonModule: true,
      skipLibCheck: true,
    },
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: false,
  });

  async extract(filePath: string): Promise<ExtractionResult> {
    const absPath = path.resolve(filePath);
    const nodes: SystemNode[] = [];
    const edges: SystemEdge[] = [];

    // Remove stale version of the file if re-extracting
    const existing = this.project.getSourceFile(absPath);
    if (existing) this.project.removeSourceFile(existing);

    const sf = this.project.addSourceFileAtPath(absPath);

    // ── Module node ──
    const modId = moduleId(filePath);
    nodes.push({
      id: modId,
      kind: "module",
      name: path.basename(filePath),
      filePath,
    });

    // ── Import declarations → dependency/module nodes + import edges ──
    for (const decl of sf.getImportDeclarations()) {
      const specifier = decl.getModuleSpecifierValue();
      const isRelative = specifier.startsWith(".") || specifier.startsWith("/");

      if (isRelative) {
        // Internal import → resolve to a module node
        const resolved = decl.getModuleSpecifierSourceFile();
        const targetPath = resolved
          ? path.relative(process.cwd(), resolved.getFilePath())
          : specifier;
        const targetId = moduleId(targetPath);

        const eid = edgeId(modId, "imports", targetId);
        edges.push({
          id: eid,
          kind: "imports",
          fromId: modId,
          toId: targetId,
          confidence: resolved ? 1.0 : 0.5,
        });
      } else {
        // External dependency node
        const dId = depId(specifier);
        if (!nodes.find((n) => n.id === dId)) {
          nodes.push({
            id: dId,
            kind: "dependency",
            name: specifier,
            filePath: "",
          });
        }
        const eid = edgeId(modId, "imports", dId);
        edges.push({
          id: eid,
          kind: "imports",
          fromId: modId,
          toId: dId,
          confidence: 1.0,
        });
      }
    }

    // ── Function declarations ──
    const fnNodes: SystemNode[] = [];

    for (const fn of sf.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;
      const fid = functionId(filePath, name);
      const node: SystemNode = {
        id: fid,
        kind: "function",
        name,
        filePath,
        startLine: fn.getStartLineNumber(),
        endLine: fn.getEndLineNumber(),
      };
      nodes.push(node);
      fnNodes.push(node);

      // function is contained in module
      edges.push({
        id: edgeId(modId, "imports", fid),
        kind: "imports",
        fromId: modId,
        toId: fid,
        confidence: 1.0,
        metadata: { relationship: "contains" },
      });
    }

    // Arrow functions / function expressions assigned to top-level variables
    for (const varDecl of sf.getVariableDeclarations()) {
      const init = varDecl.getInitializer();
      if (
        !init ||
        (!init.isKind(SyntaxKind.ArrowFunction) &&
          !init.isKind(SyntaxKind.FunctionExpression))
      )
        continue;
      const name = varDecl.getName();
      const fid = functionId(filePath, name);
      const node: SystemNode = {
        id: fid,
        kind: "function",
        name,
        filePath,
        startLine: varDecl.getStartLineNumber(),
        endLine: varDecl.getEndLineNumber(),
      };
      nodes.push(node);
      fnNodes.push(node);
      edges.push({
        id: edgeId(modId, "imports", fid),
        kind: "imports",
        fromId: modId,
        toId: fid,
        confidence: 1.0,
        metadata: { relationship: "contains" },
      });
    }

    // ── Call edges (best-effort, within this file) ──
    for (const fnNode of fnNodes) {
      const decl =
        sf.getFunction(fnNode.name) ??
        sf.getVariableDeclaration(fnNode.name);
      if (!decl) continue;

      const callExprs = decl.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of callExprs) {
        const expr = call.getExpression();
        const calleeName = expr.isKind(SyntaxKind.Identifier)
          ? expr.getText()
          : expr.isKind(SyntaxKind.PropertyAccessExpression)
            ? expr.getName()
            : null;

        if (!calleeName) continue;

        // Try to find callee in the same file
        const localTarget = fnNodes.find((n) => n.name === calleeName);
        if (localTarget) {
          const eid = edgeId(fnNode.id, "calls", localTarget.id);
          if (!edges.find((e) => e.id === eid)) {
            edges.push({
              id: eid,
              kind: "calls",
              fromId: fnNode.id,
              toId: localTarget.id,
              confidence: 1.0,
            });
          }
          continue;
        }

        // Try to resolve via ts-morph type checker
        try {
          const sym = expr.getSymbol();
          const decls = sym?.getDeclarations() ?? [];
          for (const d of decls) {
            const sf2 = d.getSourceFile();
            if (sf2.getFilePath() === absPath) continue;
            const targetPath = path.relative(process.cwd(), sf2.getFilePath());
            const targetId = functionId(targetPath, calleeName);
            const eid = edgeId(fnNode.id, "calls", targetId);
            if (!edges.find((e) => e.id === eid)) {
              edges.push({
                id: eid,
                kind: "calls",
                fromId: fnNode.id,
                toId: targetId,
                confidence: 0.9,
              });
            }
          }
        } catch {
          // unresolvable — skip
        }
      }
    }

    return { nodes, edges };
  }
}
