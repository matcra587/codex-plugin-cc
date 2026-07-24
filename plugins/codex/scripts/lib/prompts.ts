import { fs, path } from "./platform.ts";

export function loadPromptTemplate(rootDir: string, name: string): string {
  const promptPath = path.join(rootDir, "prompts", `${name}.md`);
  return fs.readFileSync(promptPath, "utf8");
}

export function interpolateTemplate(template: string, variables: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match: string, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) {
      return "";
    }

    return variables[key] ?? "";
  });
}
