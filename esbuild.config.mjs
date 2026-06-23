import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

esbuild
    .build({
        entryPoints: ["main.ts"],
        bundle: true,
        external: [
            "obsidian",
            "electron",
            "@codemirror/state",
            "@codemirror/view",
            "@codemirror/language",
            ...builtins,
        ],
        format: "cjs",
        target: "es2020",
        logLevel: "info",
        sourcemap: prod ? false : "inline",
        treeShaking: true,
        outfile: "main.js",
        minify: prod,
    })
    .catch(() => process.exit(1));