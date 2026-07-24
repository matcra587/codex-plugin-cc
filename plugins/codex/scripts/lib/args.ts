export interface ParseArgsConfig<ValueOption extends string = string, BooleanOption extends string = string> {
  valueOptions?: readonly ValueOption[];
  booleanOptions?: readonly BooleanOption[];
  aliasMap?: Record<string, string>;
}

export type ParsedOption = string | boolean;
export type ParsedOptions<
  ValueOption extends string = never,
  BooleanOption extends string = never
> = Partial<Record<ValueOption, string>> &
  Partial<Record<BooleanOption, boolean>> &
  Record<string, ParsedOption | undefined>;
export type AnyParsedOptions = Record<string, ParsedOption | undefined>;

export interface ParsedArguments<ValueOption extends string = string, BooleanOption extends string = string> {
  options: ParsedOptions<ValueOption, BooleanOption>;
  positionals: string[];
}

export function parseArgs<const ValueOption extends string = never, const BooleanOption extends string = never>(
  argv: string[],
  config: ParseArgsConfig<ValueOption, BooleanOption> = {}
): ParsedArguments<ValueOption, BooleanOption> {
  const valueOptions = new Set<string>(config.valueOptions ?? []);
  const booleanOptions = new Set<string>(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options: AnyParsedOptions = {};
  const positionals: string[] = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey = "", inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return {
    options: options as ParsedOptions<ValueOption, BooleanOption>,
    positionals
  };
}

export function splitRawArgumentString(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
