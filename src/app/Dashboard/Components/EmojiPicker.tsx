"use client";

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
};

export default function EmojiPicker({ onSelect, className }: Props) {
  return (
    <div className={`card-surface w-64 p-2 ${className ?? ""}`}>
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
    </div>
  );
}
