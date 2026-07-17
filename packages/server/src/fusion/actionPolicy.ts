import { parser } from "@lezer/python";

type PythonSyntaxNode = ReturnType<typeof parser.parse>["topNode"];

export const FUSION_ACTION_POLICY_VERSION = "fusion-python-v3";

export type FusionActionPolicyResult =
  | { ok: true; policyVersion: typeof FUSION_ACTION_POLICY_VERSION }
  | { ok: false; policyVersion: typeof FUSION_ACTION_POLICY_VERSION; violations: string[] };

const ALLOWED_IMPORTS = new Set(["adsk", "adsk.core", "adsk.fusion", "math"]);
const ALLOWED_BUILTINS = new Set([
  "Exception", "RuntimeError", "ValueError", "abs", "all", "any", "bool", "delete_owned", "dict",
  "enumerate", "float", "int", "isinstance", "len", "list", "max", "min", "range",
  "register_entity", "reversed", "round", "set", "sorted", "str", "sum", "tuple", "world_to_sketch", "zip",
]);
const REVIEWED_LANGUAGE_CONSTRUCTS = new Set([
  "AssignStatement", "UpdateStatement", "ExpressionStatement", "PassStatement", "BreakStatement",
  "ContinueStatement", "ReturnStatement", "RaiseStatement", "ImportStatement", "IfStatement",
  "ForStatement", "TryStatement", "FunctionDefinition", "ArrayComprehensionExpression",
  "DictionaryComprehensionExpression", "SetComprehensionExpression", "ComprehensionExpression",
]);
const LANGUAGE_CONSTRUCT = /(?:Statement|Definition|ComprehensionExpression)$/;
const DENIED_NAMES = new Set([
  "__builtins__", "_ExecuteHandler", "_CreatedHandler", "_DestroyHandler", "_action", "_active_design",
  "_command", "_complete", "_destroyed", "_error", "_expected_document", "_handlers", "_reference_tokens",
  "Application", "Data", "DataFile", "DataFolder", "DataProject", "ExportManager", "FileDialog",
  "FolderDialog", "ImportManager", "UserInterface", "breakpoint", "compile",
  // Note: plain lowercase names are NOT denied here. Denying a variable name gives
  // no security - the real capabilities are blocked at acquisition (Application.get
  // below, and the denied *properties* activeDocument/activeProduct/...). Denying
  // everyday names like `app` (appearance), `cam`, `args` only false-rejects valid
  // model code. Keep denials to escape-enabling builtins and injected harness names.
  "delattr", "dir", "eval", "exec", "exit", "getattr", "globals", "help", "input", "json",
  "locals", "memoryview", "open", "quit", "setattr", "time", "traceback", "type", "vars",
]);
const DENIED_PROPERTIES = new Set([
  "Application", "Data", "DataFile", "DataFolder", "DataProject", "ExportManager", "FileDialog",
  "FolderDialog", "ImportManager", "UserInterface", "activeDocument", "activeProduct", "activeViewport",
  "application", "cam", "close", "command", "commandDefinitions", "data", "dataFile", "doEvents",
  "documents", "electronics", "executeFailed", "executeFailedMessage", "executeTextCommand", "exportManager",
  "fileDialog", "firingEvent", "folderDialog", "importManager", "parentApplication", "parentCommandDefinition",
  "parentDocument", "save", "saveAs", "sender", "terminate", "userInterface",
]);

function importTarget(statement: string): string | undefined {
  const compact = statement.trim().replace(/\s+/g, " ");
  const direct = /^import ([A-Za-z0-9_.]+)(?: as [A-Za-z_][A-Za-z0-9_]*)?$/.exec(compact);
  if (direct) return direct[1];
  const from = /^from ([A-Za-z0-9_.]+) import /.exec(compact);
  return from?.[1];
}

function importedBindings(statement: string): string[] | undefined {
  const compact = statement.trim().replace(/\s+/g, " ");
  const direct = /^import ([A-Za-z0-9_.]+)(?: as ([A-Za-z_][A-Za-z0-9_]*))?$/.exec(compact);
  if (direct) return [direct[2] ?? direct[1]!.split(".")[0]!];
  const from = /^from [A-Za-z0-9_.]+ import (.+)$/.exec(compact);
  if (!from || from[1]!.includes("*") || from[1]!.includes("(") || from[1]!.includes(")")) return undefined;
  const bindings = from[1]!.split(",").map((item) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*$/.exec(item);
    return match?.[2] ?? match?.[1];
  });
  return bindings.every((name): name is string => Boolean(name)) ? bindings : undefined;
}

const SUPPLIED_CAPABILITIES = new Set(["action", "design", "materialLibraries", "references", "root", "transaction"]);

type SourceRange = { from: number; to: number };

function addScopedBinding(bindings: Map<string, SourceRange[]>, name: string, scope: SourceRange): void {
  const ranges = bindings.get(name) ?? [];
  ranges.push(scope);
  bindings.set(name, ranges);
}

function bindingIsVisible(
  globals: Set<string>,
  scoped: Map<string, SourceRange[]>,
  name: string,
  position: number,
): boolean {
  return globals.has(name) || (scoped.get(name)?.some((range) => position >= range.from && position < range.to) ?? false);
}

function declaredNames(source: string, tree: ReturnType<typeof parser.parse>): {
  names: Set<string>;
  callables: Set<string>;
  scopedNames: Map<string, SourceRange[]>;
  scopedCallables: Map<string, SourceRange[]>;
  adskRoots: Set<string>;
  scopedAdskRoots: Map<string, SourceRange[]>;
  nonReferencePositions: Set<number>;
} {
  const names = new Set([...SUPPLIED_CAPABILITIES, ...ALLOWED_BUILTINS]);
  const callables = new Set(ALLOWED_BUILTINS);
  const scopedNames = new Map<string, SourceRange[]>();
  const scopedCallables = new Map<string, SourceRange[]>();
  const adskRoots = new Set<string>();
  const scopedAdskRoots = new Map<string, SourceRange[]>();
  const nonReferencePositions = new Set<number>();
  const cursor = tree.cursor();
  const addBinding = (name: string, scope: SourceRange | undefined, callable = false): void => {
    if (scope) {
      addScopedBinding(scopedNames, name, scope);
      if (callable) addScopedBinding(scopedCallables, name, scope);
    } else {
      names.add(name);
      if (callable) callables.add(name);
    }
  };
  const addAdskRoot = (name: string, scope: SourceRange | undefined): void => {
    if (scope) addScopedBinding(scopedAdskRoots, name, scope);
    else adskRoots.add(name);
  };
  const collectBindingNode = (node: PythonSyntaxNode, scope: SourceRange | undefined): void => {
    if (node.name === "VariableName") { addBinding(source.slice(node.from, node.to), scope); return; }
    if (!["TupleExpression", "ArrayExpression", "Pattern"].includes(node.name)) return;
    for (let child = node.firstChild; child; child = child.nextSibling) collectBindingNode(child, scope);
  };
  const collectBindingsBefore = (node: PythonSyntaxNode, stopName: string, scope: SourceRange | undefined): void => {
    for (let child = node.firstChild; child && child.name !== stopName; child = child.nextSibling) {
      collectBindingNode(child, scope);
    }
  };
  const directChild = (node: PythonSyntaxNode, name: string): PythonSyntaxNode | undefined => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === name) return child;
    }
    return undefined;
  };
  function collect(scope: SourceRange | undefined): void {
    const text = source.slice(cursor.from, cursor.to);
    let childScope = scope;
    if (cursor.name === "ImportStatement") {
      const bindings = importedBindings(text) ?? [];
      for (const binding of bindings) addBinding(binding, scope, true);
      if (/^\s*import\s+adsk(?:\.(?:core|fusion))?(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*$/.test(text)) {
        for (const binding of bindings) addAdskRoot(binding, scope);
      }
    } else if (cursor.name === "AssignStatement" || cursor.name === "UpdateStatement") {
      collectBindingsBefore(cursor.node, cursor.name === "AssignStatement" ? "AssignOp" : "UpdateOp", scope);
    } else if (cursor.name === "ForStatement") {
      const body = directChild(cursor.node, "Body");
      if (body) {
        childScope = { from: body.from, to: body.to };
        collectBindingsBefore(cursor.node, "in", childScope);
        for (let child = cursor.node.firstChild; child && child.name !== "in"; child = child.nextSibling) {
          if (child.name === "VariableName") nonReferencePositions.add(child.from);
        }
      }
    } else if (cursor.name.endsWith("ComprehensionExpression")) {
      const children: PythonSyntaxNode[] = [];
      for (let child = cursor.node.firstChild; child; child = child.nextSibling) children.push(child);
      const result = children.find((child) => !["[", "{", "("].includes(child.name));
      for (let index = 0; index < children.length; index += 1) {
        if (children[index]?.name !== "for") continue;
        const target = children[index + 1];
        const inToken = children[index + 2];
        const iterable = children[index + 3];
        if (target?.name !== "VariableName" || inToken?.name !== "in" || !iterable || !result) continue;
        const name = source.slice(target.from, target.to);
        addScopedBinding(scopedNames, name, { from: result.from, to: result.to });
        addScopedBinding(scopedNames, name, { from: iterable.to, to: cursor.to });
        nonReferencePositions.add(target.from);
      }
    } else if (cursor.name === "FunctionDefinition") {
      const header = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/.exec(text);
      if (header) {
        addBinding(header[1]!, scope, true);
        const body = directChild(cursor.node, "Body");
        if (body) childScope = { from: body.from, to: body.to };
      }
    } else if (cursor.name === "ParamList") {
      let bindingCollected = false;
      for (let child = cursor.node.firstChild; child; child = child.nextSibling) {
        if (child.name === ",") bindingCollected = false;
        else if (child.name === "VariableName" && !bindingCollected) {
          addBinding(source.slice(child.from, child.to), scope);
          nonReferencePositions.add(child.from);
          bindingCollected = true;
        }
      }
    } else if (cursor.name === "ArgList") {
      for (let child = cursor.node.firstChild; child; child = child.nextSibling) {
        if (child.name === "VariableName" && child.nextSibling?.name === "AssignOp") {
          nonReferencePositions.add(child.from);
        }
      }
    } else if (cursor.name === "TryStatement") {
      const children: PythonSyntaxNode[] = [];
      for (let child = cursor.node.firstChild; child; child = child.nextSibling) children.push(child);
      for (let index = 0; index < children.length; index += 1) {
        if (children[index]?.name !== "as") continue;
        const alias = children[index + 1];
        const body = children[index + 2];
        if (alias?.name === "VariableName" && body?.name === "Body") {
          addBinding(source.slice(alias.from, alias.to), { from: body.from, to: body.to });
          nonReferencePositions.add(alias.from);
        }
      }
    }
    if (cursor.firstChild()) {
      do collect(childScope); while (cursor.nextSibling());
      cursor.parent();
    }
  }
  collect(undefined);
  return { names, callables, scopedNames, scopedCallables, adskRoots, scopedAdskRoots, nonReferencePositions };
}

/** Fixed syntax-aware mitigation for generated code executed inside Fusion.
 * The trusted harness supplies `design`, `root`, `references`, `action`,
 * `transaction`, and the read-only `materialLibraries` catalog; the body has
 * no reason to acquire the broader application/document/UI state. */
export function validateFusionActionBody(source: string, options: { allowDestructive?: boolean } = {}): FusionActionPolicyResult {
  const violations = new Set<string>();
  if (source.length === 0 || source.length > 40_000) violations.add("Action body must contain 1 to 40000 characters.");
  const tree = parser.parse(source);
  const declared = declaredNames(source, tree);
  const cursor = tree.cursor();

  function visit(insideImport = false): void {
    const text = source.slice(cursor.from, cursor.to);
    if (cursor.type.isError) violations.add("Action body must be valid Python.");
    if (LANGUAGE_CONSTRUCT.test(cursor.name) && !REVIEWED_LANGUAGE_CONSTRUCTS.has(cursor.name)) {
      violations.add(`Python construct ${cursor.name} is not in the reviewed language allowlist.`);
    }
    if (["AwaitExpression", "LambdaExpression", "YieldExpression", "NamedExpression", "Decorator"].includes(cursor.name)) {
      violations.add(`Python construct ${cursor.name} is not in the reviewed language allowlist.`);
    }
    if (cursor.name === "ImportStatement") {
      const target = importTarget(text);
      if (!target || !importedBindings(text)) violations.add("Import statement shape is not permitted.");
      else if (!ALLOWED_IMPORTS.has(target)) violations.add(`Import capability ${target} is not permitted.`);
      if (/^\s*from\s+adsk\s+import\s+/.test(text)
        && !/^\s*from\s+adsk\s+import\s+(?:core|fusion)(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*$/.test(text)) {
        violations.add("Only adsk.core or adsk.fusion may be imported from the adsk root package.");
      }
      if (/^\s*from\s+adsk\s+import\s+/.test(text) && /\b(cam|electronics)\b/.test(text)) {
        violations.add("Non-modeling Autodesk namespace import is not permitted.");
      }
    }
    if ((cursor.name === "VariableName" || cursor.name === "PropertyName") && text.startsWith("__")) {
      violations.add("Dunder access is not permitted.");
    }
    if (cursor.name === "VariableName" && DENIED_NAMES.has(text)) violations.add(`Capability ${text} is not permitted.`);
    if (cursor.name === "VariableName" && !insideImport && !declared.nonReferencePositions.has(cursor.from)
      && !bindingIsVisible(declared.names, declared.scopedNames, text, cursor.from)) {
      violations.add(`Ambient capability ${text} is not in the supplied object-capability allowlist.`);
    }
    if (cursor.name === "VariableName" && !insideImport
      && bindingIsVisible(declared.adskRoots, declared.scopedAdskRoots, text, cursor.from)) {
      const parent = cursor.node.parent;
      const memberText = parent?.name === "MemberExpression" ? source.slice(parent.from, parent.to).replace(/\s+/g, "") : "";
      if (!new RegExp(`^${text}\\.(?:core|fusion)(?:\\.|$)`).test(memberText)) {
        violations.add(`Broad Autodesk package ${text} may only qualify adsk.core or adsk.fusion access.`);
      }
    }
    if (cursor.name === "PropertyName" && DENIED_PROPERTIES.has(text)) violations.add(`Capability ${text} is not permitted.`);
    if (cursor.name === "PropertyName" && text === "deleteMe" && !options.allowDestructive) {
      violations.add("Destructive rebuilding requires an explicitly approved destructive-rebuild action.");
    }
    if (cursor.name === "CallExpression") {
      const callee = text.slice(0, Math.max(0, text.indexOf("("))).replace(/\s+/g, "");
      if (/^adsk\.core\.Application\.get$/.test(callee)) violations.add("Ambient Fusion application acquisition is not permitted.");
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(callee)
        && !bindingIsVisible(declared.callables, declared.scopedCallables, callee, cursor.from)) {
        violations.add(`Call to ${callee} is not an allowed pure built-in or local function.`);
      }
    }
    const childInsideImport = insideImport || cursor.name === "ImportStatement";
    if (cursor.firstChild()) {
      do visit(childInsideImport); while (cursor.nextSibling());
      cursor.parent();
    }
  }
  visit();
  return violations.size === 0
    ? { ok: true, policyVersion: FUSION_ACTION_POLICY_VERSION }
    : { ok: false, policyVersion: FUSION_ACTION_POLICY_VERSION, violations: [...violations] };
}
