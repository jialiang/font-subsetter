import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import { selectorSpecificity } from "@csstools/selector-specificity";

import { parseDocument } from "htmlparser2";
import * as cssSelect from "css-select";

// Browser defaults that decide the font of elements the page doesn't style
const browserCss = `
  html { font-weight: 400; font-style: normal; }
  h1, h2, h3, h4, h5, h6, b, strong, th { font-weight: 700; }
  address, cite, dfn, em, i, var { font-style: italic; }
`;

const selectorProcessor = selectorParser();

const unquote = (family) => family.trim().replace(/^["']|["']$/g, "");

// The first listed family we subset: anything else renders in a font we don't produce.
const findFamily = (value, families) =>
  postcss.list
    .comma(value)
    .map(unquote)
    .find((family) => Object.hasOwn(families, family)) ?? null;

const parseWeight = (value) => {
  const keyword = value.toLowerCase();

  if (keyword === "normal") return 400;
  if (keyword === "bold") return 700;

  const weight = Number(keyword);
  const isStandardWeight = weight >= 100 && weight <= 900 && weight % 100 === 0;

  return isStandardWeight ? weight : undefined;
};

// Oblique has no files of its own, so it renders like italic.
const parseStyle = (value) => (value.toLowerCase() === "normal" ? "normal" : "italic");

const properties = new Map([
  ["font-family", "family"],
  ["font-weight", "weight"],
  ["font-style", "style"],
]);

// CSS-wide keywords that make a font property take its parent's value
const inheritingKeywords = new Set(["inherit", "unset", "revert", "revert-layer"]);
const inheritParent = Symbol("inherit parent");

// `initial` means the browser's own font, which is never a subset family.
const initialValues = { family: null, weight: 400, style: "normal" };

// An undefined value means the declaration doesn't decide a font.
const parseDeclaration = ({ prop, value }, families) => {
  const property = properties.get(prop);
  const keyword = value.toLowerCase();

  if (!property) return;
  if (inheritingKeywords.has(keyword)) return { property, value: inheritParent };
  if (keyword === "initial") return { property, value: initialValues[property] };

  if (property === "family") return { property, value: findFamily(value, families) };
  if (property === "weight") return { property, value: parseWeight(value) };

  return { property, value: parseStyle(value) };
};

const warnedSelectors = new Set();

// css-select can't evaluate states such as :focus, so their rules are skipped.
const compileSelector = (selector) => {
  try {
    return cssSelect.compile(selector);
  } catch (error) {
    if (warnedSelectors.has(selector)) return;

    warnedSelectors.add(selector);
    console.warn(`font-subsetter: skipped "${selector}" (${error.message})`);
  }
};

const compileSelectors = (selectors) =>
  selectors.flatMap((selector) => {
    const query = compileSelector(selector);
    if (!query) return [];

    // Specificity: a counts ids, b classes and attributes, c element types.
    const { a, b, c } = selectorSpecificity(selectorProcessor.astSync(selector));

    return [{ query, a, b, c }];
  });

// Font rules, most specific first. Style rules inside at-rules such as @media are skipped.
const parseRules = (css, families) => {
  const rules = [];

  for (const node of postcss.parse(browserCss + css).nodes) {
    if (node.type !== "rule" || node.selector.includes("::")) continue;

    const declarations = [];

    for (const declaration of node.nodes) {
      if (declaration.type !== "decl") continue;

      const parsed = parseDeclaration(declaration, families);
      if (parsed?.value === undefined) continue;

      // Position in the stylesheet: on equal specificity the later declaration wins.
      declarations.push({ ...parsed, order: declaration.source.start.offset });
    }

    if (!declarations.length) continue;

    for (const selector of compileSelectors(node.selectors)) {
      for (const declaration of declarations) rules.push({ ...declaration, ...selector });
    }
  }

  return rules.sort(
    (first, second) =>
      second.a - first.a || second.b - first.b || second.c - first.c || second.order - first.order,
  );
};

// Each element takes its most specific matching rule or inherits from its parent.
const walk = (nodes, rules, inherited, onText) => {
  for (const node of nodes) {
    // Scripts and styles aren't "tag" nodes, so they're skipped here without
    // leaving the tree, which keeps :nth-child counting what the browser counts.
    if (node.type !== "tag" || node.name === "head") continue;

    const font = { ...inherited };

    for (const property of ["family", "weight", "style"]) {
      const rule = rules.find(
        (rule) => rule.property === property && cssSelect.is(node, rule.query),
      );
      if (rule && rule.value !== inheritParent) font[property] = rule.value;
    }

    for (const child of node.children) {
      if (child.type === "text" && font.family) onText(font, child.data);
    }

    walk(node.children, rules, font, onText);
  }
};

// The text the page renders in each requested font, merged across all stylesheets.
export const collectFontText = ({ html, stylesheets, families }) => {
  const document = parseDocument(html);
  const fonts = new Map();

  for (const css of stylesheets) {
    const rules = parseRules(String(css), families);

    walk(document.children, rules, {}, ({ family, weight, style }, text) => {
      const key = `${family}|${weight}|${style}`;

      if (!fonts.has(key)) fonts.set(key, { family, weight, style, text: "" });
      fonts.get(key).text += text;
    });
  }

  return [...fonts.values()];
};

// The weight and style of every @font-face each subset family declares.
export const collectDeclaredFaces = ({ stylesheets, families }) => {
  const faces = new Map();

  for (const css of stylesheets) {
    postcss.parse(String(css)).walkAtRules("font-face", (rule) => {
      const face = { family: undefined, weight: 400, style: "normal" };

      rule.walkDecls((declaration) => {
        const { prop, value } = declaration;

        if (prop === "font-family") face.family = unquote(value);
        if (prop === "font-weight") face.weight = parseWeight(value);
        if (prop === "font-style") face.style = parseStyle(value);
      });

      if (!Object.hasOwn(families, face.family) || face.weight === undefined) return;

      if (!faces.has(face.family)) faces.set(face.family, new Set());
      faces.get(face.family).add(`${face.weight}|${face.style}`);
    });
  }

  return faces;
};
