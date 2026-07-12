import { parser } from "@lezer/python";
import type { SyntaxNode } from "@lezer/common";

const COMPONENT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

function stringValue(code: string, node: SyntaxNode): string | undefined {
  if (node.name !== "String") return undefined;
  const literal = code.slice(node.from, node.to);
  const match = /^(?:[ru]*)?(["'])([a-z][a-z0-9_-]{0,31})\1$/i.exec(literal);
  return match && COMPONENT_ID_PATTERN.test(match[2] ?? "") ? match[2] : undefined;
}

function assignmentValue(code: string, assignment: SyntaxNode): string[] | undefined {
  const children: SyntaxNode[] = [];
  const cursor = assignment.cursor();
  if (cursor.firstChild()) {
    do children.push(cursor.node);
    while (cursor.nextSibling());
  }
  const expression = children.at(-1);
  if (!expression) return undefined;
  const single = stringValue(code, expression);
  if (single) return [single];
  if (expression.name !== "ArrayExpression") return undefined;

  const ids: string[] = [];
  const itemCursor = expression.cursor();
  if (!itemCursor.firstChild()) return undefined;
  do {
    if (itemCursor.name === "String") {
      const id = stringValue(code, itemCursor.node);
      if (!id) return undefined;
      ids.push(id);
    } else if (!new Set(["[", "]", ","]).has(itemCursor.name)) {
      return undefined;
    }
  } while (itemCursor.nextSibling());
  return ids.length > 0 ? ids : undefined;
}

/**
 * Parse one unique top-level literal COMPONENT assignment for preflight budget
 * attribution. Ambiguous or malformed declarations are deliberately unclassified;
 * the Python harness remains the evidence authority and reports the gate error.
 */
export function parseComponentDeclaration(code: string): string[] | undefined {
  const tree = parser.parse(code);
  const assignments = tree.topNode.getChildren("AssignStatement").filter((node) => {
    const name = node.getChild("VariableName");
    return name !== null && code.slice(name.from, name.to) === "COMPONENT";
  });
  if (assignments.length !== 1) return undefined;
  return assignmentValue(code, assignments[0] as SyntaxNode);
}
