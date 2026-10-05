import type Parser from 'tree-sitter';
import type { SymbolObservation } from './contracts.js';

export type Declaration = { node: Parser.SyntaxNode; kind: SymbolObservation['kind']; name: string | null; scope: SymbolObservation['scope']; signatureDisplay?: string };
// Fields/node names are from the pinned 0.23.5 node-types.json. These are syntax
// boundaries, including unnamed lambda/anonymous bodies, never resolved types.
export function javaDeclaration(node: Parser.SyntaxNode, scope: SymbolObservation['scope']): Declaration[] {
  if (!node.isNamed) return [];
  const kinds: Record<string, SymbolObservation['kind']> = {
    package_declaration: 'package', import_declaration: 'import', class_declaration: 'class', interface_declaration: 'interface', record_declaration: 'record', enum_declaration: 'enum', enum_constant: 'enum-constant', annotation_type_declaration: 'annotation-type', annotation_type_element_declaration: 'annotation-element', method_declaration: 'method', constructor_declaration: 'constructor', compact_constructor_declaration: 'constructor', static_initializer: 'initializer', annotation: 'annotation', marker_annotation: 'annotation', lambda_expression: 'lambda',
  };
  if (node.type === 'field_declaration' || node.type === 'constant_declaration') return node.childrenForFieldName('declarator').map(declarator => ({ node, kind: 'field', name: declarator.childForFieldName('name')?.text ?? null, scope }));
  let kind = kinds[node.type];
  if (node.type === 'formal_parameter' || node.type === 'spread_parameter') {
    if (node.parent?.type === 'formal_parameters' && node.parent.parent?.type === 'record_declaration') kind = 'record-component';
  }
  if (node.type === 'class_body' && node.parent?.type === 'object_creation_expression') kind = 'anonymous-class';
  if (node.type === 'block' && node.parent?.type === 'class_body') kind = 'initializer';
  if (!kind) return [];
  const name = kind === 'initializer' || kind === 'anonymous-class' || kind === 'lambda' ? null : kind === 'package' || kind === 'import' ? node.namedChildren.find(child => child.type === 'identifier' || child.type === 'scoped_identifier')?.text ?? null : node.childForFieldName('name')?.text ?? null;
  const parameters = node.childForFieldName('parameters');
  return [{ node, kind, name, scope, ...(kind === 'method' || kind === 'constructor' ? { signatureDisplay: `${name ?? ''}${parameters?.text ?? ' (compact constructor)'}` } : {}) }];
}
