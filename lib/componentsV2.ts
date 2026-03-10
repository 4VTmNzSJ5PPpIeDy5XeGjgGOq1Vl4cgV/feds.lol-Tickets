/**
 * Builds Components V2 containers that look like embeds (accent color + title, description, fields, footer).
 * Use with MessageFlags.IsComponentsV2 when sending.
 */
import {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder
} from "discord.js";

export interface EmbedLikeField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface EmbedLikeOptions {
  title?: string;
  description?: string;
  fields?: EmbedLikeField[];
  color?: number;
  footer?: string;
  timestamp?: boolean | Date;
  /** Optional image URL for a section thumbnail (e.g. panel image) */
  imageUrl?: string;
}

/**
 * Build a single ContainerBuilder that mimics an embed: accent color, then title, description, fields, footer.
 * Use in message payload: { flags: MessageFlags.IsComponentsV2, components: [container, ...actionRows] }
 */
export function buildEmbedLikeContainer(options: EmbedLikeOptions): ContainerBuilder {
  const parts: string[] = [];
  if (options.title) parts.push(`## ${options.title}`);
  if (options.description) parts.push(options.description);
  if (options.fields?.length) {
    for (const f of options.fields) {
      parts.push(`**${f.name}**\n${f.value}`);
    }
  }
  const timestamp =
    options.timestamp === true
      ? new Date()
      : options.timestamp instanceof Date
        ? options.timestamp
        : null;
  if (timestamp) parts.push(`*${timestamp.toISOString()}*`);
  if (options.footer) parts.push(`*${options.footer}*`);

  const container = new ContainerBuilder();
  if (options.color != null) container.setAccentColor(options.color);

  if (options.imageUrl && parts.length > 0) {
    const section = new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(parts.join("\n\n"))
      )
      .setThumbnailAccessory(
        new ThumbnailBuilder({ media: { url: options.imageUrl } })
      );
    container.addSectionComponents(section);
  } else if (parts.length > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(parts.join("\n\n"))
    );
  }

  return container;
}

/**
 * Build a container from title + description + optional image (for panel-style messages).
 * If imageUrl is set, uses a Section with thumbnail.
 */
export function buildPanelLikeContainer(
  title: string,
  description: string,
  options: { color?: number; imageUrl?: string; footer?: string } = {}
): ContainerBuilder {
  const parts: string[] = [`## ${title}`, description];
  if (options.footer) parts.push(`*${options.footer}*`);

  const container = new ContainerBuilder();
  if (options.color != null) container.setAccentColor(options.color);

  if (options.imageUrl) {
    const section = new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(parts.join("\n\n"))
      )
      .setThumbnailAccessory(
        new ThumbnailBuilder({ media: { url: options.imageUrl } })
      );
    container.addSectionComponents(section);
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(parts.join("\n\n"))
    );
  }

  return container;
}
