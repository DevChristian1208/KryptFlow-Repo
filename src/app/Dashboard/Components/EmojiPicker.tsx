"use client";

import Image from "next/image";

export const COMMON_EMOJIS = [
  "😀",
  "😄",
  "😁",
  "😅",
  "🤣",
  "😂",
  "🙂",
  "😉",
  "😊",
  "😍",
  "😘",
  "😛",
  "😜",
  "🤔",
  "🙄",
  "😴",
  "🤯",
  "🥳",
  "👍",
  "🙏",
  "👏",
  "💪",
  "🔥",
  "✨",
  "🎉",
  "❤️",
  "💙",
  "💚",
  "💛",
  "💜",
];

type Props = {
  onSelect: (emoji: string) => void;
  className?: string;
  customEmojis?: { id: string; name: string; url: string }[];
};

export default function EmojiPicker({ onSelect, className, customEmojis }: Props) {
  return (
    <div className={`card-surface w-64 p-2 max-h-72 overflow-y-auto ${className ?? ""}`}>
      <div className="grid grid-cols-8 gap-1">
        {COMMON_EMOJIS.map((e) => (
          <button
            key={e}
            type="button"
            className="text-xl leading-[32px] h-8 w-8 hover:bg-[var(--border-subtle)] rounded"
            onClick={() => onSelect(e)}
          >
            {e}
          </button>
        ))}
      </div>

      {customEmojis && customEmojis.length > 0 && (
        <>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--foreground-secondary)] mt-2 mb-1 px-0.5">
            Server-Emojis
          </p>
          <div className="grid grid-cols-8 gap-1">
            {customEmojis.map((e) => (
              <button
                key={e.id}
                type="button"
                title={`:${e.name}:`}
                className="h-8 w-8 flex items-center justify-center hover:bg-[var(--border-subtle)] rounded"
                onClick={() => onSelect(`:${e.name}:`)}
              >
                <Image src={e.url} alt={e.name} width={20} height={20} unoptimized />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
