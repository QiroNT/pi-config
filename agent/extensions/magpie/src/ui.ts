/**
 * `/magpie`: the toggles, drawn with the same list component Pi's own
 * `/settings` uses, so it moves and toggles the same way.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  SettingsList,
  Spacer,
  Text,
  type SettingItem,
  type SettingsListTheme,
} from "@earendil-works/pi-tui";
import { exposureOf, FEATURES, FEATURE_HELP, FEATURE_LABELS, type MagpieConfig } from "./config.ts";

export interface ScreenOptions {
  config: MagpieConfig;
  /** The gateway the credential names, or "" when not signed in. */
  gateway: string;
  version?: string;
  /** Called after every change, with the config to save and apply. */
  onChange: (next: MagpieConfig) => Promise<void> | void;
  /** Rows that act instead of toggling; they return the line to show. */
  onAction: (action: "refresh" | "status") => Promise<string>;
}

const SECONDS = ["10", "15", "30", "60", "120"];
const EXPOSURES = ["codemode", "deferred", "direct"];

function listTheme(theme: Theme): SettingsListTheme {
  return {
    label: (text, selected) => (selected ? theme.fg("accent", text) : text),
    value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
    description: (text) => theme.fg("dim", text),
    cursor: theme.fg("accent", "→ "),
    hint: (text) => theme.fg("dim", text),
  };
}

function itemsOf(config: MagpieConfig, gateway: string, version?: string): SettingItem[] {
  const signedIn = gateway
    ? `gateway: ${gateway}${version ? ` · magpie ${version}` : ""}`
    : "not signed in — run /login magpie";

  const items: SettingItem[] = [
    {
      id: "gateway",
      label: "gateway",
      description: "The URL and key come from /login, never from magpie.json.",
      currentValue: signedIn,
    },
  ];

  for (const feature of FEATURES) {
    items.push({
      id: feature,
      label: FEATURE_LABELS[feature],
      description: FEATURE_HELP[feature],
      currentValue: config.features[feature] ? "on" : "off",
      values: ["on", "off"],
    });
  }

  items.push(
    {
      id: "statuslineSeconds",
      label: "status line refresh",
      description: "Seconds between status line reads. Each one is a request to the gateway.",
      currentValue: String(config.statuslineSeconds),
      values: SECONDS,
    },
    {
      id: "exposure",
      label: "MCP exposure",
      description: "How the tools of magpie's MCP servers reach the model.",
      currentValue: config.exposure,
      values: EXPOSURES,
    },
    {
      id: "refresh",
      label: "refresh catalog",
      description: "Ask the gateway for its models again, now.",
      currentValue: "press enter",
      values: ["run"],
    },
    {
      id: "status",
      label: "show status",
      description: "The gateway's line, its quotas and the last route, in the transcript.",
      currentValue: "press enter",
      values: ["run"],
    },
  );

  return items;
}

export async function openSettings(ctx: ExtensionContext, options: ScreenOptions): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("magpie's settings need interactive mode; /magpie status works here", "warning");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const config: MagpieConfig = { ...options.config, features: { ...options.config.features } };
    const items = itemsOf(config, options.gateway, options.version);

    /** Save and apply the screen's config; a failure is told, not thrown at nobody. */
    const change = (): void => {
      void Promise.resolve()
        .then(() => options.onChange({ ...config, features: { ...config.features } }))
        .catch((error: unknown) => {
          ctx.ui.notify(`magpie: ${error instanceof Error ? error.message : String(error)}`, "warning");
        });
    };

    const list = new SettingsList(
      items,
      Math.min(items.length, 16),
      listTheme(theme),
      (id, value) => {
        const feature = FEATURES.find((name) => name === id);
        if (feature) {
          config.features[feature] = value === "on";
          list.updateValue(id, value === "on" ? "on" : "off");
          change();
        } else if (id === "statuslineSeconds") {
          config.statuslineSeconds = Number(value) || config.statuslineSeconds;
          list.updateValue(id, String(config.statuslineSeconds));
          change();
        } else if (id === "exposure") {
          config.exposure = exposureOf(value);
          list.updateValue(id, config.exposure);
          change();
        } else if (id === "refresh" || id === "status") {
          void options
            .onAction(id)
            .then((line) => list.updateValue(id, line))
            .catch((error: unknown) => {
              list.updateValue(id, error instanceof Error ? error.message : String(error));
            })
            .finally(() => tui.requestRender());
        }
        tui.requestRender();
      },
      () => done(undefined),
      { enableSearch: true },
    );

    const screen = new Container();
    screen.addChild(new Text(theme.fg("accent", theme.bold("magpie")), 1, 0));
    screen.addChild(new Text(theme.fg("dim", "The gateway's models, footer and MCP servers."), 1, 0));
    screen.addChild(new Spacer(1));
    screen.addChild(list);

    return {
      render: (width: number) => screen.render(width),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
      invalidate: () => screen.invalidate(),
    };
  });
}
