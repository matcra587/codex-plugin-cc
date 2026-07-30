// Modified from openai/codex-plugin-cc by Matt Craven in 2026.
// See NOTICE for attribution and plugins/codex/CHANGELOG.md for changes.

export class UnknownOptionError extends Error {
  readonly option: string;

  constructor(option: string) {
    super(
      `Unknown option ${option}. Options must come before the prompt text; write \`--\` before text that starts with a dash.`
    );
    this.name = "UnknownOptionError";
    this.option = option;
  }
}

export interface ParseArgsConfig<ValueOption extends string = string, BooleanOption extends string = string> {
  valueOptions?: readonly ValueOption[];
  booleanOptions?: readonly BooleanOption[];
  aliasMap?: Record<string, string>;
  /**
   * Set for commands whose trailing positionals are free text rather than
   * identifiers. Option parsing then stops at the first positional, so prose
   * like "fix the --model handling" survives instead of being read as options.
   *
   * Leave unset for commands taking an identifier, such as `cancel <job-id>
   * --json`, where options legitimately follow the positional.
   */
  trailingText?: boolean;
}

export type ParsedOption = string | boolean;
export type ParsedOptions<ValueOption extends string = never, BooleanOption extends string = never> = Partial<
  Record<ValueOption, string>
> &
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

    // Options are only recognised before the first positional. Everything from
    // there on is prompt text, so prose like "fix the --model handling" reaches
    // Codex intact instead of hijacking a real option.
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
      if (config.trailingText) {
        passthrough = true;
      }
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

      throw new UnknownOptionError(`--${rawKey}`);
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

    throw new UnknownOptionError(`-${shortKey}`);
  }

  return {
    options: options as ParsedOptions<ValueOption, BooleanOption>,
    positionals
  };
}

interface RawToken {
  value: string;
  start: number;
}

function tokenizeRawArgumentString(raw: string): RawToken[] {
  const tokens: RawToken[] = [];
  let current = "";
  let start = -1;
  let quote: string | null = null;
  let escaping = false;

  const begin = (index: number): void => {
    if (start === -1) {
      start = index;
    }
  };
  const flush = (): void => {
    if (start !== -1) {
      tokens.push({ value: current, start });
      current = "";
      start = -1;
    }
  };

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index] as string;

    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      begin(index);
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

    if (character === "'" || character === '"') {
      begin(index);
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      flush();
      continue;
    }

    begin(index);
    current += character;
  }

  if (escaping) {
    current += "\\";
  }
  flush();

  return tokens;
}

export function splitRawArgumentString(raw: string): string[] {
  return tokenizeRawArgumentString(raw).map((token) => token.value);
}

/**
 * Splits a single raw argument string into leading option tokens plus the
 * untouched remainder.
 *
 * Slash commands hand the whole of `$ARGUMENTS` over as one argument, so it has
 * to be re-split to find the flags. Splitting all of it corrupted the prompt:
 * quotes and backslashes were stripped, and prose like "the --model handling"
 * was read as a real option. Only the leading run of recognised options is
 * tokenized; from the first token that is not one, the rest of the string is
 * returned exactly as the user typed it.
 */
export function splitLeadingOptions(raw: string, config: ParseArgsConfig = {}): string[] {
  const valueOptions = new Set<string>(config.valueOptions ?? []);
  const booleanOptions = new Set<string>(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const tokens = tokenizeRawArgumentString(raw);
  const leading: string[] = [];

  // The remainder is emitted behind an explicit `--` so parseArgs treats it as
  // one positional even when the prompt itself begins with a dash.
  const remainderFrom = (index: number): string[] => {
    const token = tokens[index];
    if (token === undefined) {
      return [];
    }
    const rest = raw.slice(token.start).trim();
    return rest ? ["--", rest] : [];
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const value = (tokens[index] as RawToken).value;

    if (value === "--") {
      return [...leading, ...remainderFrom(index + 1)];
    }

    if (!value.startsWith("-") || value === "-") {
      return [...leading, ...remainderFrom(index)];
    }

    const isLong = value.startsWith("--");
    const [rawKey = "", inlineValue] = isLong ? value.slice(2).split("=", 2) : [value.slice(1), undefined];
    const key = aliasMap[rawKey] ?? rawKey;

    if (booleanOptions.has(key)) {
      leading.push(value);
      continue;
    }

    if (valueOptions.has(key)) {
      leading.push(value);
      if (inlineValue === undefined) {
        const next = tokens[index + 1];
        if (next === undefined) {
          throw new Error(`Missing value for ${isLong ? "--" : "-"}${rawKey}`);
        }
        leading.push(next.value);
        index += 1;
      }
      continue;
    }

    // Let parseArgs report it, so the message is identical however the command
    // was invoked.
    leading.push(value);
  }

  return leading;
}
