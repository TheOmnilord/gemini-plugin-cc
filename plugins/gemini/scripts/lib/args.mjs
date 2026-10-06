// Argument parsing shared by the companion subcommands.
//
// Slash commands hand the script "$ARGUMENTS" as one string, so a lone argv
// entry is split with lightweight shell-like quoting before it is parsed.

export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  // Options that may repeat; their values are collected in an array.
  const listOptions = new Set(config.listOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passthrough || token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      passthrough = true;
      continue;
    }

    const long = token.startsWith("--");
    const body = token.slice(long ? 2 : 1);
    const separator = body.indexOf("=");
    const rawKey = separator === -1 ? body : body.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : body.slice(separator + 1);
    const key = aliasMap[rawKey] ?? rawKey;

    if (booleanOptions.has(key)) {
      options[key] = inlineValue === undefined ? true : !/^(false|0|no|off)$/i.test(inlineValue);
      continue;
    }
    if (valueOptions.has(key) || listOptions.has(key)) {
      const value = inlineValue ?? argv[index + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${long ? "--" : "-"}${rawKey}.`);
      }
      if (listOptions.has(key)) {
        options[key] = [...(options[key] ?? []), value];
      } else {
        options[key] = value;
      }
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    positionals.push(token);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let active = false;
  let quote = null;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];

    if (quote) {
      if (char === "\\" && (next === quote || next === "\\")) {
        current += next;
        index += 1;
      } else if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (/\s/.test(char)) {
      if (active) {
        tokens.push(current);
        current = "";
        active = false;
      }
      continue;
    }

    // Quotes only open at the start of a token, or of an option's value
    // (--flag="a b"), and only when they are closed later, so apostrophes in
    // free text ("the user's input") stay literal.
    const opensValue = active && /^-[^=]*=$/.test(current);
    if ((char === '"' || char === "'") && (!active || opensValue) && raw.indexOf(char, index + 1) !== -1) {
      quote = char;
      active = true;
      continue;
    }

    // Backslash escapes quotes, backslashes and whitespace only, which keeps
    // Windows paths such as C:\repo\file.md intact.
    if (char === "\\" && next !== undefined && /["'\\\s]/.test(next)) {
      current += next;
      index += 1;
      active = true;
      continue;
    }

    current += char;
    active = true;
  }

  if (active) {
    tokens.push(current);
  }
  return tokens;
}

export function normalizeArgv(argv) {
  if (argv.length !== 1) {
    return argv;
  }
  const [raw] = argv;
  if (!raw || !raw.trim()) {
    return [];
  }
  return splitRawArgumentString(raw);
}
