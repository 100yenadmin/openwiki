import { isValidModelId, normalizeModelId } from "./constants.js";
import type { OpenWikiCommand } from "./agent/types.js";

export type HelpRow = {
  label: string;
  description: string;
};

export type HelpContent = {
  title: string;
  description: string;
  usage: string[];
  commands: HelpRow[];
  options: HelpRow[];
  developmentOptions: HelpRow[];
  examples: string[];
  developmentExamples: string[];
};

export type CliCommand =
  | { kind: "help"; exitCode: 0 }
  | {
      kind: "export-neondiff-packet";
      exitCode: 0;
      maxBytes: number | null;
      outputPath: string | null;
      repo: string | null;
    }
  | {
      kind: "run";
      exitCode: 0;
      command: OpenWikiCommand;
      dryRun: boolean;
      modelId: string | null;
      noAgentInstructions: boolean;
      print: boolean;
      shouldStart: boolean;
      userMessage: string | null;
    }
  | {
      kind: "error";
      exitCode: 1;
      message: string;
    };

export function parseCommand(argv: string[]): CliCommand {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { kind: "help", exitCode: 0 };
  }

  let dryRun = false;
  let exportNeonDiffPacket = false;
  let exportMaxBytes: number | null = null;
  let exportOutputPath: string | null = null;
  let exportRepo: string | null = null;
  let modelId: string | null = null;
  let noAgentInstructions = false;
  let print = false;
  let command: OpenWikiCommand = "chat";
  const userMessageParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      return { kind: "help", exitCode: 0 };
    }

    if (arg === "--dry-run") {
      if (!isDevelopmentMode()) {
        return {
          kind: "error",
          exitCode: 1,
          message: `Unknown option: ${arg}`,
        };
      }

      dryRun = true;
      continue;
    }

    if (arg === "--print" || arg === "-p") {
      print = true;
      continue;
    }

    if (arg === "--export-neondiff-packet") {
      exportNeonDiffPacket = true;
      continue;
    }

    if (arg === "--output") {
      const nextArg = argv[index + 1];

      if (!nextArg || nextArg.startsWith("-")) {
        return {
          kind: "error",
          exitCode: 1,
          message: "--output requires a relative path.",
        };
      }

      exportOutputPath = nextArg;
      index += 1;
      continue;
    }

    if (arg.startsWith("--output=")) {
      const [, outputPath = ""] = arg.split("=", 2);

      if (!outputPath) {
        return {
          kind: "error",
          exitCode: 1,
          message: "--output requires a relative path.",
        };
      }

      exportOutputPath = outputPath;
      continue;
    }

    if (arg === "--repo") {
      const nextArg = argv[index + 1];

      if (!nextArg || nextArg.startsWith("-")) {
        return {
          kind: "error",
          exitCode: 1,
          message: "--repo requires an owner/repo name.",
        };
      }

      exportRepo = nextArg;
      index += 1;
      continue;
    }

    if (arg.startsWith("--repo=")) {
      const [, repo = ""] = arg.split("=", 2);

      if (!repo) {
        return {
          kind: "error",
          exitCode: 1,
          message: "--repo requires an owner/repo name.",
        };
      }

      exportRepo = repo;
      continue;
    }

    if (arg === "--max-packet-bytes") {
      const nextArg = argv[index + 1];

      if (!nextArg || nextArg.startsWith("-")) {
        return {
          kind: "error",
          exitCode: 1,
          message: "--max-packet-bytes requires a positive integer.",
        };
      }

      const parsedBytes = parsePositiveInteger(nextArg);

      if (parsedBytes === null) {
        return {
          kind: "error",
          exitCode: 1,
          message: "--max-packet-bytes requires a positive integer.",
        };
      }

      exportMaxBytes = parsedBytes;
      index += 1;
      continue;
    }

    if (arg.startsWith("--max-packet-bytes=")) {
      const [, rawBytes = ""] = arg.split("=", 2);
      const parsedBytes = parsePositiveInteger(rawBytes);

      if (parsedBytes === null) {
        return {
          kind: "error",
          exitCode: 1,
          message: "--max-packet-bytes requires a positive integer.",
        };
      }

      exportMaxBytes = parsedBytes;
      continue;
    }

    if (arg === "--no-agent-instructions") {
      noAgentInstructions = true;
      continue;
    }

    if (arg === "--init" || arg === "--update") {
      const nextCommand = arg === "--init" ? "init" : "update";

      if (command !== "chat" && command !== nextCommand) {
        return {
          kind: "error",
          exitCode: 1,
          message: "--init and --update cannot be used together.",
        };
      }

      command = nextCommand;
      continue;
    }

    if (arg === "--modelId" || arg === "--model-id") {
      const nextArg = argv[index + 1];

      if (!nextArg || nextArg.startsWith("-")) {
        return {
          kind: "error",
          exitCode: 1,
          message: `${arg} requires a model ID.`,
        };
      }

      const parsedModelId = normalizeModelId(nextArg);

      if (!isValidModelId(parsedModelId)) {
        return {
          kind: "error",
          exitCode: 1,
          message: `Invalid model ID: ${nextArg}`,
        };
      }

      modelId = parsedModelId;
      index += 1;
      continue;
    }

    if (arg.startsWith("--modelId=") || arg.startsWith("--model-id=")) {
      const [, rawModelId = ""] = arg.split("=", 2);
      const parsedModelId = normalizeModelId(rawModelId);

      if (!isValidModelId(parsedModelId)) {
        return {
          kind: "error",
          exitCode: 1,
          message: `Invalid model ID: ${rawModelId}`,
        };
      }

      modelId = parsedModelId;
      continue;
    }

    if (arg.startsWith("-")) {
      return {
        kind: "error",
        exitCode: 1,
        message: `Unknown option: ${arg}`,
      };
    }

    userMessageParts.push(arg);
  }

  const userMessage =
    userMessageParts.length > 0 ? userMessageParts.join(" ") : null;

  if (exportNeonDiffPacket) {
    if (
      command !== "chat" ||
      dryRun ||
      modelId !== null ||
      noAgentInstructions ||
      print ||
      userMessage !== null
    ) {
      return {
        kind: "error",
        exitCode: 1,
        message:
          "--export-neondiff-packet cannot be combined with agent run options or messages.",
      };
    }

    return {
      kind: "export-neondiff-packet",
      exitCode: 0,
      maxBytes: exportMaxBytes,
      outputPath: exportOutputPath,
      repo: exportRepo,
    };
  }

  if (
    exportOutputPath !== null ||
    exportRepo !== null ||
    exportMaxBytes !== null
  ) {
    return {
      kind: "error",
      exitCode: 1,
      message:
        "--output, --repo, and --max-packet-bytes require --export-neondiff-packet.",
    };
  }

  const shouldStart = command !== "chat" || userMessage !== null;

  if (print && !shouldStart) {
    return {
      kind: "error",
      exitCode: 1,
      message: "-p, --print requires a message, --init, or --update.",
    };
  }

  return {
    kind: "run",
    exitCode: 0,
    command,
    dryRun,
    modelId,
    noAgentInstructions,
    print,
    shouldStart,
    userMessage,
  };
}

export function isDevelopmentMode(): boolean {
  return (
    process.env.NODE_ENV === "development" || process.env.OPENWIKI_DEV === "1"
  );
}

export const helpContent: HelpContent = {
  title: "OpenWiki",
  description:
    "Run a documentation agent that generates and maintains a project wiki.",
  usage: [
    "openwiki [--modelId <model>]",
    "openwiki [--modelId <model>] [message]",
    "openwiki --init [message]",
    "openwiki --update [message]",
    "openwiki --export-neondiff-packet [--output <path>]",
  ],
  commands: [
    {
      label: "openwiki",
      description: "Open the interactive OpenWiki chat.",
    },
  ],
  options: [
    {
      label: "--init",
      description: "Generate initial OpenWiki documentation.",
    },
    {
      label: "--update",
      description: "Update existing OpenWiki documentation.",
    },
    {
      label: "-p, --print",
      description: "Run once and print the final assistant output.",
    },
    {
      label: "--no-agent-instructions",
      description: "Do not add OpenWiki references to AGENTS.md or CLAUDE.md.",
    },
    {
      label: "--modelId <id>",
      description: "Use a model ID for this run.",
    },
    {
      label: "--export-neondiff-packet",
      description:
        "Export openwiki/ Markdown as a NeonDiff repo-wiki packet without running a model.",
    },
    {
      label: "--output <path>",
      description:
        "Write the NeonDiff packet to a relative path instead of stdout.",
    },
    {
      label: "--repo <owner/repo>",
      description: "Set the repository identity for packet export.",
    },
    {
      label: "--max-packet-bytes <n>",
      description: "Set the NeonDiff packet byte budget.",
    },
  ],
  developmentOptions: [
    {
      label: "--dry-run",
      description: "Show what would run without invoking the agent.",
    },
  ],
  examples: [
    "openwiki",
    "openwiki --init",
    "openwiki --update",
    'openwiki "What can you do?"',
    'openwiki -p "Summarize what OpenWiki can do"',
    "openwiki --modelId gpt-5.5",
    'openwiki --update --modelId gpt-5.5 "Please document the API routes first"',
    "openwiki --export-neondiff-packet --output .neondiff/repo-wiki-packet.json",
  ],
  developmentExamples: ["openwiki --dry-run"],
};

export function getHelpText(): string {
  const helpSections = [
    helpContent.title,
    `  ${helpContent.description}`,
    "",
    "Usage",
    ...helpContent.usage.map((line) => `  ${line}`),
    "",
    "Commands",
    ...formatRows(helpContent.commands),
    "",
    "Options",
    ...formatRows(helpContent.options),
    "",
  ];

  if (isDevelopmentMode()) {
    helpSections.push(
      "Development Options",
      ...formatRows(helpContent.developmentOptions),
      "",
    );
  }

  helpSections.push(
    "Examples",
    ...helpContent.examples.map((line) => `  ${line}`),
  );

  if (isDevelopmentMode()) {
    helpSections.push(
      ...helpContent.developmentExamples.map((line) => `  ${line}`),
    );
  }

  return helpSections.join("\n");
}

function parsePositiveInteger(value: string): number | null {
  if (!/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function formatRows(rows: HelpRow[]): string[] {
  const labelWidth = Math.max(...rows.map((row) => row.label.length));

  return rows.map(
    (row) => `  ${row.label.padEnd(labelWidth)}  ${row.description}`,
  );
}
