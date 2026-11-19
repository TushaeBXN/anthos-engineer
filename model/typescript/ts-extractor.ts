import { Node, Project, SyntaxKind, type SourceFile, type Symbol as TsSymbol } from "ts-morph";
import path from "node:path";
import type { SystemNode, SystemEdge } from "../schema.js";
import type { Extractor, ExtractionResult } from "../extractor.js";

function moduleId(filePath: string): string {
  return `module:${filePath}`;
}

function nodeId(kind: "function" | "method", filePath: string, name: string): string {
  return `${kind}:${filePath}:${name}`;
}

function depId(specifier: string): string {
  return `dep:${specifier}`;
}

function edgeId(fromId: string, kind: string, toId: string): string {
  return `${fromId}->${kind}->${toId}`;
}

function isFunction(init: Node | undefined): boolean {
  return Boolean(init && (init.isKind(SyntaxKind.ArrowFunction) || init.isKind(SyntaxKind.FunctionExpression)));
}

/**
 * What the index calls a declaration, if it records one: top-level functions, and the methods,
 * function-valued properties and constructors of top-level named classes. Interface members,
 * nested functions and library code are not indexed.
 */
function indexedName(decl: Node): { kind: "function" | "method"; name: string } | null {
  if (Node.isFunctionDeclaration(decl) && Node.isSourceFile(decl.getParent())) {
    const name = decl.getName();
    return name ? { kind: "function", name } : null;
  }
  if (Node.isVariableDeclaration(decl) && Node.isSourceFile(decl.getVariableStatement()?.getParent()) && isFunction(decl.getInitializer())) {
    return { kind: "function", name: decl.getName() };
  }
  const cls = decl.getParent();
  const owner = Node.isClassDeclaration(cls) && Node.isSourceFile(cls.getParent()) ? cls.getName() : undefined;
  if (owner && Node.isMethodDeclaration(decl)) return { kind: "method", name: `${owner}.${decl.getName()}` };
  if (owner && Node.isPropertyDeclaration(decl) && isFunction(decl.getInitializer())) return { kind: "method", name: `${owner}.${decl.getName()}` };
  // `new Store()` resolves to the class: link to its constructor, if it declares one.
  if (Node.isClassDeclaration(decl) && Node.isSourceFile(decl.getParent()) && decl.getName() && decl.getConstructors().length > 0) {
    return { kind: "method", name: `${decl.getName()}.constructor` };
  }
  return null;
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

    // ── Functions and class methods: the things calls are linked between ──
    const callers: { node: SystemNode; body: Node }[] = [];
    const add = (kind: "function" | "method", name: string, decl: Node) => {
      const id = nodeId(kind, filePath, name);
      if (nodes.some((n) => n.id === id)) return;
      const node: SystemNode = { id, kind, name, filePath, startLine: decl.getStartLineNumber(), endLine: decl.getEndLineNumber() };
      nodes.push(node);
      callers.push({ node, body: decl });
      // The module contains it.
      edges.push({ id: edgeId(modId, "imports", id), kind: "imports", fromId: modId, toId: id, confidence: 1.0, metadata: { relationship: "contains" } });
    };

    for (const fn of sf.getFunctions()) {
      const name = fn.getName();
      if (name) add("function", name, fn);
    }
    for (const v of sf.getVariableDeclarations()) {
      if (isFunction(v.getInitializer())) add("function", v.getName(), v);
    }
    for (const cls of sf.getClasses()) {
      const className = cls.getName();
      if (!className) continue;
      for (const ctor of cls.getConstructors()) add("method", `${className}.constructor`, ctor);
      for (const m of cls.getMethods()) add("method", `${className}.${m.getName()}`, m);
      for (const prop of cls.getProperties()) {
        if (isFunction(prop.getInitializer())) add("method", `${className}.${prop.getName()}`, prop);
      }
    }

    // ── Calls: resolved through the type checker, in this file or in other project files ──
    for (const { node, body } of callers) {
      const calls = [...body.getDescendantsOfKind(SyntaxKind.CallExpression), ...body.getDescendantsOfKind(SyntaxKind.NewExpression)];
      for (const call of calls) {
        for (const targetId of this.callTargets(call.getExpression(), sf, filePath, nodes)) {
          const eid = edgeId(node.id, "calls", targetId);
          if (!edges.some((e) => e.id === eid)) {
            edges.push({ id: eid, kind: "calls", fromId: node.id, toId: targetId, confidence: 0.9 });
          }
        }
      }
    }

    return { nodes, edges };
  }

  /** The indexed functions or methods a call (or `new`) can reach, as node ids. */
  private callTargets(expr: Node, sf: SourceFile, filePath: string, nodes: SystemNode[]): string[] {
    let sym: TsSymbol | undefined;
    try {
      sym = expr.getSymbol();
      if (sym?.isAlias()) sym = sym.getAliasedSymbol() ?? sym;
    } catch {
      sym = undefined;
    }

    // Unresolvable plain call such as `helper()`: fall back to a function of that name in this file.
    // Never for `x.name()`, where a same-named local function is almost always unrelated.
    if (!sym) {
      if (!expr.isKind(SyntaxKind.Identifier)) return [];
      const local = nodes.find((n) => n.kind === "function" && n.name === expr.getText());
      return local ? [local.id] : [];
    }

    const targets: string[] = [];
    for (const decl of sym.getDeclarations()) {
      const target = indexedName(decl);
      if (!target) continue;
      const declFile = decl.getSourceFile();
      // Only calls into the project's own code, not libraries or type definitions.
      if (declFile.isDeclarationFile() || declFile.isInNodeModules()) continue;
      const targetPath = declFile === sf ? filePath : path.relative(process.cwd(), declFile.getFilePath());
      if (targetPath.startsWith("..") || path.isAbsolute(targetPath)) continue;
      targets.push(nodeId(target.kind, targetPath, target.name));
    }
    return targets;
  }
}
