// Syntax-aware ban-list checker (task L2; docs/ARCHITECTURE.md, section 5, step 5).
// Uses web-tree-sitter with the C++ WASM grammar plus macro expansion and lexical
// scope tracking. Generic across problems: it reads only the source code and the
// constraint's bannedNames.
import { createRequire } from "node:module";
import type ParserType from "web-tree-sitter";
import type { Constraint, ConstraintResult, EvidenceLine } from "./types.ts";

const require = createRequire(import.meta.url);
const Parser = require("web-tree-sitter") as typeof ParserType;

let parserReady: Promise<ParserType> | null = null;

async function getCppParser(): Promise<ParserType> {
  if (!parserReady) {
    parserReady = (async () => {
      await Parser.init();
      const wasmPath =
        require.resolve("tree-sitter-wasms/out/tree-sitter-cpp.wasm");
      const cppLang = await Parser.Language.load(wasmPath);
      const parser = new Parser();
      parser.setLanguage(cppLang);
      return parser;
    })();
  }
  return parserReady;
}

const CPP_KEYWORDS = new Set([
  "alignas",
  "alignof",
  "asm",
  "auto",
  "bool",
  "break",
  "case",
  "catch",
  "char",
  "char8_t",
  "char16_t",
  "char32_t",
  "class",
  "concept",
  "const",
  "consteval",
  "constexpr",
  "constinit",
  "const_cast",
  "continue",
  "co_await",
  "co_return",
  "co_yield",
  "decltype",
  "default",
  "delete",
  "do",
  "double",
  "dynamic_cast",
  "else",
  "enum",
  "explicit",
  "export",
  "extern",
  "false",
  "float",
  "for",
  "friend",
  "goto",
  "if",
  "inline",
  "int",
  "long",
  "mutable",
  "namespace",
  "new",
  "noexcept",
  "nullptr",
  "operator",
  "private",
  "protected",
  "public",
  "register",
  "reinterpret_cast",
  "requires",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "static_assert",
  "static_cast",
  "struct",
  "switch",
  "template",
  "this",
  "thread_local",
  "throw",
  "true",
  "try",
  "typedef",
  "typeid",
  "typename",
  "union",
  "unsigned",
  "using",
  "virtual",
  "void",
  "volatile",
  "wchar_t",
  "while",
]);

interface BannedSpecs {
  keywords: Set<string>;
  /** Full canonical qualified names without leading "::", e.g. "std::sort", "std::ranges::sort". */
  qualified: Map<string, { nsParts: string[]; symbol: string }>;
  /** Unqualified non-keyword names, e.g. "qsort", "__gcd", "rbegin". */
  unqualified: Set<string>;
}

function parseBannedSpecs(bannedNames: string[]): BannedSpecs {
  const keywords = new Set<string>();
  const qualified = new Map<string, { nsParts: string[]; symbol: string }>();
  const unqualified = new Set<string>();

  for (const raw of bannedNames) {
    const name = raw.trim().replace(/^::/, "");
    if (!name) continue;
    if (CPP_KEYWORDS.has(name)) {
      keywords.add(name);
    } else if (name.includes("::")) {
      const parts = name.split("::").filter((p) => p !== "");
      if (parts.length >= 2) {
        const symbol = parts[parts.length - 1]!;
        const nsParts = parts.slice(0, -1);
        qualified.set(parts.join("::"), { nsParts, symbol });
      } else if (parts.length === 1) {
        unqualified.add(parts[0]!);
      }
    } else {
      unqualified.add(name);
    }
  }
  return { keywords, qualified, unqualified };
}

interface MacroDef {
  name: string;
  params: string[] | null;
  body: string;
  defLine: number;
}

/** Strips C/C++ comments from a single-line macro body while keeping strings intact. */
function stripMacroComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      break;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) break;
      out += " ";
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      while (i < text.length) {
        const c = text[i]!;
        out += c;
        if (c === "\\") {
          if (i + 1 < text.length) {
            out += text[i + 1]!;
            i += 2;
            continue;
          }
        }
        i++;
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Collects #define macros (joining backslash line continuations). */
function extractMacros(lines: string[]): Map<string, MacroDef> {
  const macros = new Map<string, MacroDef>();
  let inBlockComment = false;

  for (let idx = 0; idx < lines.length; idx++) {
    let line = lines[idx]!;
    if (inBlockComment) {
      const closeIdx = line.indexOf("*/");
      if (closeIdx === -1) continue;
      line = line.slice(closeIdx + 2);
      inBlockComment = false;
    }

    // Check if an unclosed block comment starts on a non-directive line.
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("#")) {
      let i = 0;
      while (i < line.length) {
        const c = line[i]!;
        const n = line[i + 1];
        if (c === "/" && n === "/") break;
        if (c === "/" && n === "*") {
          const end = line.indexOf("*/", i + 2);
          if (end === -1) {
            inBlockComment = true;
            break;
          }
          i = end + 2;
          continue;
        }
        if (c === '"' || c === "'") {
          const q = c;
          i++;
          while (i < line.length) {
            if (line[i] === "\\") {
              i += 2;
              continue;
            }
            if (line[i] === q) {
              i++;
              break;
            }
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }

    const startLine = idx + 1;
    let combined = trimmed;
    while (combined.endsWith("\\") && idx + 1 < lines.length) {
      combined = combined.slice(0, -1) + " " + lines[++idx]!.trimStart();
    }

    const undefMatch = /^#\s*undef\s+([A-Za-z_]\w*)/.exec(combined);
    if (undefMatch) {
      macros.delete(undefMatch[1]!);
      continue;
    }

    const defMatch = /^#\s*define\s+([A-Za-z_]\w*)(.*)$/.exec(combined);
    if (!defMatch) continue;
    const name = defMatch[1]!;
    const rest = defMatch[2] ?? "";

    // In C++, no space before '(' means a function-like macro.
    let params: string[] | null = null;
    let bodyRaw = rest;
    if (rest.startsWith("(")) {
      const closeParen = rest.indexOf(")");
      if (closeParen !== -1) {
        const paramList = rest.slice(1, closeParen).trim();
        params =
          paramList === ""
            ? []
            : paramList.split(",").map((p) => p.trim().replace(/\.\.\.$/, ""));
        bodyRaw = rest.slice(closeParen + 1);
      }
    }
    const body = stripMacroComments(bodyRaw).trim();
    macros.set(name, { name, params, body, defLine: startLine });
  }
  return macros;
}

/** Parses `(arg1, arg2, ...)` starting at `openParenIndex` in `source`. */
function parseCallArgs(
  source: string,
  openParenIndex: number,
): { args: string[]; endIndex: number } | null {
  if (source[openParenIndex] !== "(") return null;
  const args: string[] = [];
  let depth = 1;
  let current = "";
  let i = openParenIndex + 1;

  while (i < source.length && depth > 0) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      current += ch;
      i++;
      while (i < source.length) {
        const c = source[i]!;
        current += c;
        if (c === "\\") {
          if (i + 1 < source.length) {
            current += source[i + 1]!;
            i += 2;
            continue;
          }
        }
        i++;
        if (c === quote) break;
      }
      continue;
    }
    if (ch === "(") {
      depth++;
      current += ch;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        if (current.trim() !== "" || args.length > 0) {
          args.push(current.trim());
        }
        return { args, endIndex: i + 1 };
      }
      current += ch;
    } else if (ch === "," && depth === 1) {
      args.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
    i++;
  }
  return null;
}

function substituteMacroParams(
  body: string,
  params: string[] | null,
  args: string[],
): string {
  let result = body;
  if (params && params.length > 0) {
    const paramMap = new Map<string, string>();
    params.forEach((p, idx) => {
      if (p) paramMap.set(p, args[idx] ?? "");
    });
    // Replace parameter tokens outside quotes.
    result = result.replace(/\b([A-Za-z_]\w*)\b/g, (m, id: string) =>
      paramMap.has(id) ? paramMap.get(id)! : m,
    );
  }
  // Evaluate token-pasting `##`.
  result = result.replace(/\s*##\s*/g, "");
  return result;
}

function expandTextMacros(
  text: string,
  macros: Map<string, MacroDef>,
  depth = 0,
  visited = new Set<string>(),
  defLines = new Set<number>(),
): { expanded: string; defLines: number[] } {
  if (depth >= 8) {
    return { expanded: text, defLines: [...defLines] };
  }
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      while (i < text.length) {
        const c = text[i]!;
        out += c;
        if (c === "\\" && i + 1 < text.length) {
          out += text[i + 1]!;
          i += 2;
          continue;
        }
        i++;
        if (c === quote) break;
      }
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /\w/.test(text[j]!)) j++;
      const ident = text.slice(i, j);
      const macro = macros.get(ident);
      if (macro && !visited.has(ident)) {
        if (macro.params !== null) {
          let k = j;
          while (k < text.length && /\s/.test(text[k]!)) k++;
          const parsed = parseCallArgs(text, k);
          if (parsed) {
            defLines.add(macro.defLine);
            const sub = substituteMacroParams(
              macro.body,
              macro.params,
              parsed.args,
            );
            const nextVisited = new Set(visited);
            nextVisited.add(ident);
            const inner = expandTextMacros(
              sub,
              macros,
              depth + 1,
              nextVisited,
              defLines,
            );
            out += inner.expanded;
            i = parsed.endIndex;
            continue;
          }
        } else {
          defLines.add(macro.defLine);
          const nextVisited = new Set(visited);
          nextVisited.add(ident);
          const inner = expandTextMacros(
            macro.body,
            macros,
            depth + 1,
            nextVisited,
            defLines,
          );
          out += inner.expanded;
          i = j;
          continue;
        }
      }
      out += ident;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return { expanded: out, defLines: [...defLines] };
}

interface Scope {
  parent: Scope | null;
  usingNamespaces: Set<string>;
  usingTargets: Map<string, string>;
  nsAliases: Map<string, string[]>;
  declaredSymbols: Set<string>;
}

function createScope(parent: Scope | null): Scope {
  return {
    parent,
    usingNamespaces: new Set(),
    usingTargets: new Map(),
    nsAliases: new Map(),
    declaredSymbols: new Set(),
  };
}

function isDeclaredInScopeChain(scope: Scope, name: string): boolean {
  let cur: Scope | null = scope;
  while (cur) {
    if (cur.declaredSymbols.has(name)) return true;
    cur = cur.parent;
  }
  return false;
}

function findUsingTarget(scope: Scope, name: string): string | null {
  let cur: Scope | null = scope;
  while (cur) {
    if (cur.declaredSymbols.has(name)) return null;
    const target = cur.usingTargets.get(name);
    if (target) return target;
    cur = cur.parent;
  }
  return null;
}

function isNamespaceActive(
  scope: Scope,
  nsName: string,
  symbol: string,
): boolean {
  let cur: Scope | null = scope;
  while (cur) {
    if (cur.declaredSymbols.has(symbol)) return false;
    if (cur.usingNamespaces.has(nsName)) return true;
    cur = cur.parent;
  }
  return false;
}

function resolveNsAlias(scope: Scope, firstPart: string): string[] {
  let cur: Scope | null = scope;
  while (cur) {
    const alias = cur.nsAliases.get(firstPart);
    if (alias) return alias;
    cur = cur.parent;
  }
  return [firstPart];
}

/** Flattens a tree-sitter qualified_identifier into identifier parts. */
function flattenQualified(node: ParserType.SyntaxNode): string[] {
  if (node.type === "qualified_identifier") {
    const scopeNode = node.childForFieldName("scope");
    const nameNode = node.childForFieldName("name");
    const left = scopeNode ? flattenQualified(scopeNode) : [];
    const right = nameNode ? flattenQualified(nameNode) : [];
    return [...left, ...right];
  }
  if (node.type === "template_type") {
    const nameNode = node.childForFieldName("name");
    return nameNode ? flattenQualified(nameNode) : [];
  }
  if (
    node.type === "identifier" ||
    node.type === "namespace_identifier" ||
    node.type === "type_identifier"
  ) {
    return [node.text];
  }
  return [];
}

/** Extracts the declared identifier name from a declarator node. */
function extractDeclaredName(
  node: ParserType.SyntaxNode | null,
): string | null {
  if (!node) return null;
  switch (node.type) {
    case "identifier":
    case "type_identifier":
    case "field_identifier":
      return node.text;
    case "init_declarator":
    case "pointer_declarator":
    case "reference_declarator":
    case "array_declarator":
    case "parenthesized_declarator":
    case "function_declarator":
      return extractDeclaredName(node.childForFieldName("declarator"));
    default:
      return null;
  }
}

/** Registers user-defined member names inside a class or struct specifier. */
function collectClassMembers(
  classNode: ParserType.SyntaxNode,
  userClassMembers: Set<string>,
): void {
  const body = classNode.childForFieldName("body");
  if (!body) return;
  for (const child of body.namedChildren) {
    if (child.type === "function_definition" || child.type === "declaration") {
      const decl = child.childForFieldName("declarator");
      const name = extractDeclaredName(decl);
      if (name) userClassMembers.add(name);
    } else if (child.type === "field_declaration") {
      const decl = child.childForFieldName("declarator");
      const name = extractDeclaredName(decl);
      if (name) userClassMembers.add(name);
    }
  }
}

const SKIP_SUBTREE_TYPES = new Set([
  "comment",
  "string_literal",
  "raw_string_literal",
  "char_literal",
  "system_lib_string",
  "concatenated_string",
  "preproc_include",
  "preproc_def",
  "preproc_function_def",
]);

interface AnalysisContext {
  specs: BannedSpecs;
  macros: Map<string, MacroDef>;
  sourceCode: string;
  parser: ParserType;
  userClassMembers: Set<string>;
  matchedLines: Set<number>;
  /** Extra lines attributed when a violation happens inside an expanded macro. */
  attributionLines: number[] | null;
}

function recordLine(ctx: AnalysisContext, oneBasedLine: number): void {
  if (ctx.attributionLines) {
    for (const l of ctx.attributionLines) ctx.matchedLines.add(l);
  } else {
    ctx.matchedLines.add(oneBasedLine);
  }
}

function registerScopeDeclaration(
  node: ParserType.SyntaxNode,
  scope: Scope,
  ctx: AnalysisContext,
): void {
  if (node.type === "using_declaration") {
    const hasNamespaceKw = node.children.some(
      (c) => !c.isNamed() && c.type === "namespace",
    );
    if (hasNamespaceKw) {
      const target = node.namedChildren[0];
      if (target) {
        const parts = flattenQualified(target);
        if (parts.length > 0) scope.usingNamespaces.add(parts.join("::"));
      }
    } else {
      const target = node.namedChildren[0];
      if (target) {
        const parts = flattenQualified(target);
        if (parts.length >= 2) {
          const sym = parts[parts.length - 1]!;
          scope.usingTargets.set(sym, parts.join("::"));
        }
      }
    }
    return;
  }

  if (node.type === "namespace_alias_definition") {
    const aliasNode = node.childForFieldName("name");
    const targetNode = node.namedChildren.find((c) => c.id !== aliasNode?.id);
    if (aliasNode && targetNode) {
      const parts = flattenQualified(targetNode);
      if (parts.length > 0) scope.nsAliases.set(aliasNode.text, parts);
    }
    return;
  }

  if (node.type === "function_definition") {
    const decl = node.childForFieldName("declarator");
    const rawDecl = decl?.childForFieldName("declarator") ?? decl;
    if (rawDecl && rawDecl.type !== "qualified_identifier") {
      const name = extractDeclaredName(decl);
      if (name) scope.declaredSymbols.add(name);
    }
    return;
  }

  if (node.type === "declaration") {
    const typeNode = node.childForFieldName("type");
    for (const child of node.namedChildren) {
      if (child.id === typeNode?.id) continue;
      const rawInner =
        child.type === "function_declarator"
          ? child.childForFieldName("declarator")
          : child;
      if (!rawInner || rawInner.type !== "qualified_identifier") {
        const name = extractDeclaredName(child);
        if (name) scope.declaredSymbols.add(name);
      }
    }
    return;
  }

  if (node.type === "class_specifier" || node.type === "struct_specifier") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) scope.declaredSymbols.add(nameNode.text);
    collectClassMembers(node, ctx.userClassMembers);
    return;
  }

  if (node.type === "enum_specifier") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) scope.declaredSymbols.add(nameNode.text);
    return;
  }

  if (node.type === "type_definition" || node.type === "alias_declaration") {
    const nameNode =
      node.type === "alias_declaration"
        ? node.childForFieldName("name")
        : node.childForFieldName("declarator");
    const name = extractDeclaredName(nameNode);
    if (name) scope.declaredSymbols.add(name);
    return;
  }

  if (
    node.type === "parameter_declaration" ||
    node.type === "optional_parameter_declaration"
  ) {
    const name = extractDeclaredName(node.childForFieldName("declarator"));
    if (name) scope.declaredSymbols.add(name);
  }
}

function checkIdentifierAgainstBans(
  ident: string,
  line: number,
  scope: Scope,
  ctx: AnalysisContext,
): void {
  if (ctx.specs.unqualified.has(ident)) {
    if (!isDeclaredInScopeChain(scope, ident)) {
      recordLine(ctx, line);
      return;
    }
  }

  const usingTarget = findUsingTarget(scope, ident);
  if (usingTarget && ctx.specs.qualified.has(usingTarget)) {
    recordLine(ctx, line);
    return;
  }

  for (const spec of ctx.specs.qualified.values()) {
    if (spec.symbol !== ident) continue;
    const ns = spec.nsParts.join("::");
    if (isNamespaceActive(scope, ns, ident)) {
      recordLine(ctx, line);
      return;
    }
  }
}

function checkQualifiedAgainstBans(
  parts: string[],
  line: number,
  scope: Scope,
  ctx: AnalysisContext,
): void {
  if (parts.length < 2) return;
  const resolvedFirst = resolveNsAlias(scope, parts[0]!);
  const fullParts = [...resolvedFirst, ...parts.slice(1)];
  const canonical = fullParts.join("::");

  if (ctx.specs.qualified.has(canonical)) {
    recordLine(ctx, line);
    return;
  }

  // Handle partial qualification under an active `using namespace std;` (e.g. `ranges::sort`).
  const symbol = fullParts[fullParts.length - 1]!;
  for (const spec of ctx.specs.qualified.values()) {
    if (spec.symbol !== symbol) continue;
    const specParts = spec.nsParts;
    const prefixLen = specParts.length - (fullParts.length - 1);
    if (prefixLen > 0) {
      const prefixNs = specParts.slice(0, prefixLen).join("::");
      const restNs = specParts.slice(prefixLen).join("::");
      const givenNs = fullParts.slice(0, -1).join("::");
      if (restNs === givenNs && isNamespaceActive(scope, prefixNs, symbol)) {
        recordLine(ctx, line);
        return;
      }
    }
  }

  // Unqualified ban (e.g. `__gcd` or `qsort`) called as `std::__gcd` or `std::qsort`.
  if (fullParts.length === 2 && fullParts[0] === "std") {
    if (ctx.specs.unqualified.has(symbol)) {
      recordLine(ctx, line);
    }
  }
}

function expandAndCheckMacroNode(
  node: ParserType.SyntaxNode,
  scope: Scope,
  ctx: AnalysisContext,
): void {
  // Only expand macros from the original source (attributionLines === null).
  if (ctx.attributionLines !== null) return;
  const macro = ctx.macros.get(node.text);
  if (!macro) return;

  const invLine = node.startPosition.row + 1;
  let args: string[] = [];
  if (macro.params !== null) {
    let k = node.endIndex;
    while (k < ctx.sourceCode.length && /\s/.test(ctx.sourceCode[k]!)) k++;
    const parsed = parseCallArgs(ctx.sourceCode, k);
    if (parsed) args = parsed.args;
  }
  const sub = substituteMacroParams(macro.body, macro.params, args);
  const { expanded, defLines } = expandTextMacros(
    sub,
    ctx.macros,
    1,
    new Set([macro.name]),
    new Set([macro.defLine]),
  );

  const wrapped = `void __leetkob_macro__() { ${expanded} ; }`;
  const tree = ctx.parser.parse(wrapped);
  try {
    const fnBody = tree.rootNode.firstNamedChild?.childForFieldName("body");
    const targetNode = fnBody ?? tree.rootNode;
    const innerCtx: AnalysisContext = {
      ...ctx,
      attributionLines: [...new Set([invLine, ...defLines])],
    };
    visitNode(targetNode, scope, innerCtx);
  } finally {
    tree.delete();
  }
}

function visitChildren(
  node: ParserType.SyntaxNode,
  scope: Scope,
  ctx: AnalysisContext,
  skipChildIds = new Set<number>(),
): void {
  for (const child of node.children) {
    if (skipChildIds.has(child.id)) continue;
    visitNode(child, scope, ctx);
  }
}

function visitNode(
  node: ParserType.SyntaxNode,
  scope: Scope,
  ctx: AnalysisContext,
): void {
  if (SKIP_SUBTREE_TYPES.has(node.type)) return;

  const line = node.startPosition.row + 1;

  // Keyword checks
  if (
    (node.type === "for_statement" || node.type === "for_range_loop") &&
    ctx.specs.keywords.has("for")
  ) {
    recordLine(ctx, line);
  } else if (
    node.type === "while_statement" &&
    ctx.specs.keywords.has("while")
  ) {
    recordLine(ctx, line);
  } else if (node.type === "do_statement") {
    if (ctx.specs.keywords.has("do")) recordLine(ctx, line);
    if (ctx.specs.keywords.has("while")) {
      const whileTok = node.children.find(
        (c) => !c.isNamed() && c.type === "while",
      );
      if (whileTok) recordLine(ctx, whileTok.startPosition.row + 1);
    }
  } else if (node.type === "goto_statement" && ctx.specs.keywords.has("goto")) {
    recordLine(ctx, line);
  } else if (!node.isNamed() && ctx.specs.keywords.has(node.type)) {
    recordLine(ctx, line);
  }

  // Scope-creating nodes
  if (node.type === "translation_unit") {
    for (const child of node.namedChildren) {
      if (
        child.type === "function_definition" ||
        child.type === "class_specifier" ||
        child.type === "struct_specifier" ||
        child.type === "enum_specifier" ||
        child.type === "type_definition" ||
        child.type === "alias_declaration"
      ) {
        registerScopeDeclaration(child, scope, ctx);
      }
    }
    for (const child of node.children) {
      registerScopeDeclaration(child, scope, ctx);
      visitNode(child, scope, ctx);
    }
    return;
  }

  if (node.type === "namespace_definition") {
    const inner = createScope(scope);
    const body = node.childForFieldName("body");
    if (body) {
      for (const child of body.namedChildren) {
        if (
          child.type === "function_definition" ||
          child.type === "class_specifier" ||
          child.type === "struct_specifier" ||
          child.type === "enum_specifier"
        ) {
          registerScopeDeclaration(child, inner, ctx);
        }
      }
      for (const child of body.children) {
        registerScopeDeclaration(child, inner, ctx);
        visitNode(child, inner, ctx);
      }
    }
    return;
  }

  if (node.type === "compound_statement") {
    const inner = createScope(scope);
    for (const child of node.children) {
      registerScopeDeclaration(child, inner, ctx);
      visitNode(child, inner, ctx);
    }
    return;
  }

  if (
    node.type === "function_definition" ||
    node.type === "lambda_expression"
  ) {
    const inner = createScope(scope);
    const decl = node.childForFieldName("declarator");
    const params =
      decl?.childForFieldName("parameters") ??
      node.childForFieldName("declarator")?.childForFieldName("parameters");
    if (params) {
      for (const p of params.namedChildren) {
        registerScopeDeclaration(p, inner, ctx);
      }
    }
    // Visit return type and body, skipping declarator identifier itself so defining
    // `void sort(...)` doesn't trigger a false positive on `sort`.
    const skipIds = new Set<number>();
    if (node.type === "function_definition" && decl) {
      const fnNameNode = decl.childForFieldName("declarator") ?? decl;
      if (
        fnNameNode.type === "identifier" ||
        fnNameNode.type === "field_identifier"
      ) {
        skipIds.add(decl.id);
        // Still visit parameters' types/default values
        if (params) visitNode(params, inner, ctx);
      }
    }
    for (const child of node.children) {
      if (skipIds.has(child.id)) continue;
      visitNode(child, inner, ctx);
    }
    return;
  }

  if (node.type === "for_statement" || node.type === "for_range_loop") {
    const inner = createScope(scope);
    for (const child of node.children) {
      registerScopeDeclaration(child, inner, ctx);
      visitNode(child, inner, ctx);
    }
    return;
  }

  if (node.type === "class_specifier" || node.type === "struct_specifier") {
    const inner = createScope(scope);
    const body = node.childForFieldName("body");
    if (body) {
      for (const child of body.namedChildren) {
        registerScopeDeclaration(child, inner, ctx);
      }
      visitNode(body, inner, ctx);
    }
    return;
  }

  if (node.type === "using_declaration") {
    // Do not flag `using std::sort;` unless it's actually referenced, OR wait:
    // if someone writes `using std::sort;`, checking references handles calls; skip subtree
    // so `using std::sort;` itself is not treated as a call if unused? Actually,
    // `using std::sort;` brings `std::sort` into scope. Skipping subtree avoids flagging
    // unused `using` while still catching `sort(...)` calls via `usingTargets`.
    return;
  }

  if (node.type === "namespace_alias_definition") {
    return;
  }

  if (node.type === "declaration") {
    const typeNode = node.childForFieldName("type");
    if (typeNode) visitNode(typeNode, scope, ctx);
    // Visit initializer values and parameter lists, but skip the declared variable/function identifier itself.
    for (const child of node.namedChildren) {
      if (child.id === typeNode?.id) continue;
      if (child.type === "init_declarator") {
        const val = child.childForFieldName("value");
        if (val) visitNode(val, scope, ctx);
      } else if (child.type === "function_declarator") {
        const params = child.childForFieldName("parameters");
        if (params) visitNode(params, scope, ctx);
      }
    }
    return;
  }

  if (node.type === "type_definition" || node.type === "alias_declaration") {
    const typeNode = node.childForFieldName("type");
    if (typeNode) visitNode(typeNode, scope, ctx);
    return;
  }

  if (node.type === "qualified_identifier") {
    const parts = flattenQualified(node);
    checkQualifiedAgainstBans(parts, line, scope, ctx);
    // Visit template arguments if the leaf is a template_type (e.g. std::vector<std::string>)
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      let leaf: ParserType.SyntaxNode | null = nameNode;
      while (leaf && leaf.type === "qualified_identifier") {
        leaf = leaf.childForFieldName("name");
      }
      if (leaf && leaf.type === "template_type") {
        const args = leaf.childForFieldName("arguments");
        if (args) visitNode(args, scope, ctx);
      }
    }
    return;
  }

  if (node.type === "template_type") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) visitNode(nameNode, scope, ctx);
    const args = node.childForFieldName("arguments");
    if (args) visitNode(args, scope, ctx);
    return;
  }

  if (node.type === "field_expression") {
    const arg = node.childForFieldName("argument");
    if (arg) visitNode(arg, scope, ctx);
    const field = node.childForFieldName("field");
    if (field && ctx.specs.unqualified.has(field.text)) {
      if (!ctx.userClassMembers.has(field.text)) {
        recordLine(ctx, field.startPosition.row + 1);
      }
    }
    return;
  }

  if (node.type === "identifier" || node.type === "type_identifier") {
    if (ctx.macros.has(node.text)) {
      expandAndCheckMacroNode(node, scope, ctx);
    }
    checkIdentifierAgainstBans(node.text, line, scope, ctx);
    return;
  }

  visitChildren(node, scope, ctx);
}

/**
 * Evaluates a single ban-list constraint against C++ source code using tree-sitter
 * syntax analysis, lexical scope tracking and invoked-macro expansion.
 */
export async function checkBanList(
  sourceCode: string,
  constraint: Constraint,
): Promise<ConstraintResult> {
  const specs = parseBannedSpecs(constraint.bannedNames);
  if (
    specs.keywords.size === 0 &&
    specs.qualified.size === 0 &&
    specs.unqualified.size === 0
  ) {
    return {
      constraintCode: constraint.code,
      verdict: "pass",
      decidedBy: "hard_rule",
      evidence: [],
      modelCall: null,
    };
  }

  const lines = sourceCode.split("\n");
  const macros = extractMacros(lines);
  const parser = await getCppParser();
  const tree = parser.parse(sourceCode);
  const matchedLines = new Set<number>();

  try {
    const ctx: AnalysisContext = {
      specs,
      macros,
      sourceCode,
      parser,
      userClassMembers: new Set(),
      matchedLines,
      attributionLines: null,
    };
    const rootScope = createScope(null);
    visitNode(tree.rootNode, rootScope, ctx);
  } finally {
    tree.delete();
  }

  if (matchedLines.size === 0) {
    return {
      constraintCode: constraint.code,
      verdict: "pass",
      decidedBy: "hard_rule",
      evidence: [],
      modelCall: null,
    };
  }

  const evidenceList: EvidenceLine[] = [...matchedLines]
    .sort((a, b) => a - b)
    .filter((lineNum) => lineNum >= 1 && lineNum <= lines.length)
    .map((lineNum) => ({
      line: lineNum,
      text: lines[lineNum - 1]!,
    }));

  if (evidenceList.length === 0) {
    return {
      constraintCode: constraint.code,
      verdict: "pass",
      decidedBy: "hard_rule",
      evidence: [],
      modelCall: null,
    };
  }

  const [first, ...rest] = evidenceList;
  return {
    constraintCode: constraint.code,
    verdict: "violation",
    decidedBy: "hard_rule",
    evidence: [first!, ...rest],
    modelCall: null,
  };
}
