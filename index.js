import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { collectDeclaredFaces, collectFontText } from "./cascade.js";

const weightNames = {
  100: "thin",
  200: "extralight",
  300: "light",
  400: "regular",
  500: "medium",
  600: "semibold",
  700: "bold",
  800: "extrabold",
  900: "black",
};

const weights = Object.keys(weightNames).map(Number);

const defaultFileName = ({ name, weight, style }) =>
  style === "italic" ? `${name}-${weight}-italic` : `${name}-${weight}`;

// The weights a browser tries, in order, when no @font-face has the requested one:
// https://drafts.csswg.org/css-fonts/#font-style-matching
const weightFallbacks = (weight) => {
  const lighter = weights.filter((candidate) => candidate < weight).reverse();
  const heavier = weights.filter((candidate) => candidate > weight);

  if (weight === 400) return [400, 500, ...lighter, ...heavier.slice(1)];
  if (weight === 500) return [500, ...lighter, ...heavier];
  if (weight > 500) return [weight, ...heavier, ...lighter];

  return [weight, ...lighter, ...heavier];
};

// The declared @font-face the browser would render with, nearest style first.
const findDeclaredFace = ({ family, weight, style }, declaredFaces) => {
  const declared = declaredFaces.get(family) ?? new Set();
  const styles = style === "italic" ? ["italic", "normal"] : ["normal", "italic"];

  for (const candidateStyle of styles) {
    for (const candidateWeight of weightFallbacks(weight)) {
      if (declared.has(`${candidateWeight}|${candidateStyle}`)) {
        return { weight: weightNames[candidateWeight], style: candidateStyle };
      }
    }
  }

  throw new Error(`No @font-face for ${family} ${weight} ${style}`);
};

const matchFace = (font, { families, declaredFaces, fileName, sourceFiles }) => {
  const { name, source } = families[font.family];
  const face = findDeclaredFace(font, declaredFaces);
  const sourceFile = `${fileName({ name: source, ...face })}.ttf`;

  if (!sourceFiles.has(sourceFile)) throw new Error(`No source font ${sourceFile}`);

  return { sourceFile, outputName: fileName({ name, ...face }) };
};

const runPyftsubset = (pyftsubset, args, label) =>
  new Promise((resolve, reject) => {
    const childProcess = spawn(pyftsubset, args, { stdio: "inherit" });

    childProcess.on("error", reject);

    childProcess.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pyftsubset failed for ${label} (exit code ${code})`));
    });
  });

export const subsetFonts = async ({
  html,
  stylesheets,
  families: familyOptions,
  fileName = defaultFileName,
  extraCharacters = {},
  sourceDirectory,
  outputDirectory,
  pyftsubset = "pyftsubset",
  formats = ["woff2", "woff"],
}) => {
  const families = Object.fromEntries(
    Object.entries(familyOptions).map(([family, option]) => [
      family,
      typeof option === "string"
        ? { name: option, source: option }
        : { source: option.name, ...option },
    ]),
  );

  const sourceFiles = new Set(await fs.readdir(sourceDirectory));
  const fontTexts = collectFontText({ html, stylesheets, families });
  const declaredFaces = collectDeclaredFaces({ stylesheets, families });
  const lookups = { families, declaredFaces, fileName, sourceFiles };

  // Fonts that fall back to the same file share one subset.
  const faces = new Map();

  for (const { text, ...font } of fontTexts) {
    const { sourceFile, outputName } = matchFace(font, lookups);

    if (!faces.has(outputName)) faces.set(outputName, { sourceFile, text: "" });
    faces.get(outputName).text += text;
  }

  await fs.mkdir(outputDirectory, { recursive: true });

  const tasks = [...faces].flatMap(([outputName, { sourceFile, text }]) => {
    // Control characters have no glyph, so pyftsubset would report them missing.
    const characters = new Set(Array.from(text + (extraCharacters[outputName] ?? "")));
    const textToSubset = [...characters].filter((character) => character >= " ").join("");

    return formats.map((format) =>
      runPyftsubset(
        pyftsubset,
        [
          path.join(sourceDirectory, sourceFile),
          `--text=${textToSubset}`,
          "--no-ignore-missing-unicodes",
          `--output-file=${path.join(outputDirectory, `${outputName}.${format}`)}`,
          `--flavor=${format}`,
          "--with-zopfli",
          "--harfbuzz-repacker",
        ],
        `${outputName}.${format}`,
      ),
    );
  });

  await Promise.all(tasks);

  return [...faces.keys()];
};
