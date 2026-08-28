"use client";

import { useEffect, useRef, useState } from "react";
import {
  getStorage,
  ref as sRef,
  uploadBytes,
  getDownloadURL,
} from "firebase/storage";
import { Plus, Smile, ArrowUp, AtSign } from "lucide-react";
import EmojiPicker from "./EmojiPicker";
import { useToast } from "@/app/Context/ToastContext";
import type { Member } from "@/app/Context/ChannelContext";

type Props = {
  placeholder?: string;
  onSend: (text: string, mentionedUids?: string[]) => Promise<void> | void;
  disabled?: boolean;
  members?: Member[];
};

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default function MessageComposer({
  placeholder,
  onSend,
  disabled,
  members,
}: Props) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const { showToast } = useToast();

  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const emojiRef = useRef<HTMLDivElement | null>(null);
  const emojiBtnRef = useRef<HTMLButtonElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const filteredMembers = mentionOpen
    ? (members || [])
        .filter((m) => m.name.toLowerCase().startsWith(mentionQuery.toLowerCase()))
        .slice(0, 6)
    : [];

  const canSend = !disabled && !sending && !cooldown && value.trim().length > 0;

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!showEmoji) return;
      const t = e.target as Node;
      if (emojiRef.current?.contains(t)) return;
      if (emojiBtnRef.current?.contains(t)) return;
      setShowEmoji(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [showEmoji]);

  const handleSend = async () => {
    const text = value.trim();
    if (!text || sending || disabled || cooldown) return;
    setSending(true);
    try {
      const mentionedUids = (members || [])
        .filter((m) => new RegExp(`@${escapeRegex(m.name)}\\b`, "i").test(text))
        .map((m) => m.id);
      await onSend(text, mentionedUids.length ? mentionedUids : undefined);
      setValue("");
      setMentionOpen(false);
      // Kurze clientseitige Sendesperre passend zum serverseitigen
      // Rate-Limit (siehe database.rules.json) — verhindert, dass Nutzer im
      // Normalfall überhaupt erst gegen die Regel laufen.
      setCooldown(true);
      setTimeout(() => setCooldown(false), 450);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Senden fehlgeschlagen.", "error");
    } finally {
      setSending(false);
    }
  };

  const handleChange: React.ChangeEventHandler<HTMLTextAreaElement> = (e) => {
    const newValue = e.target.value;
    setValue(newValue);

    const cursor = e.target.selectionStart ?? newValue.length;
    const uptoCursor = newValue.slice(0, cursor);
    const match = uptoCursor.match(/(?:^|\s)@([\p{L}\p{N}_-]*)$/u);

    if (match && members && members.length > 0) {
      setMentionOpen(true);
      setMentionQuery(match[1]);
      setMentionStart(cursor - match[1].length - 1);
      setMentionIndex(0);
    } else {
      setMentionOpen(false);
    }
  };

  const selectMention = (member: Member) => {
    if (mentionStart === null) return;
    const before = value.slice(0, mentionStart);
    const after = value.slice(mentionStart + 1 + mentionQuery.length);
    const insertion = `@${member.name} `;
    const newValue = before + insertion + after;
    setValue(newValue);
    setMentionOpen(false);

    requestAnimationFrame(() => {
      const pos = before.length + insertion.length;
      textareaRef.current?.setSelectionRange(pos, pos);
      textareaRef.current?.focus();
    });
  };

  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (
    e
  ) => {
    if (mentionOpen && filteredMembers.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % filteredMembers.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex(
          (i) => (i - 1 + filteredMembers.length) % filteredMembers.length
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectMention(filteredMembers[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionOpen(false);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const openFileDialog = () => fileInputRef.current?.click();

  const handleFilesSelected: React.ChangeEventHandler<
    HTMLInputElement
  > = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const tooLarge = Array.from(files).filter((f) => f.size > MAX_FILE_SIZE_BYTES);
    if (tooLarge.length > 0) {
      showToast(
        `Datei zu groß (max. ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB): ${tooLarge
          .map((f) => f.name)
          .join(", ")}`,
        "error"
      );
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    const storage = getStorage();
    setSending(true);
    try {
      for (const file of Array.from(files)) {
        const path = `attachments/${Date.now()}_${file.name}`;
        const storageRef = sRef(storage, path);
        await uploadBytes(storageRef, file);
        const url = await getDownloadURL(storageRef);

        const kind = file.type.startsWith("image/") ? "image" : "file";
        const marker = `ATTACH::${kind}::${url}::${encodeURIComponent(
          file.name
        )}`;
        await onSend(marker);
      }
    } catch (err) {
      console.error("Upload fehlgeschlagen:", err);
    } finally {
      setSending(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const addEmoji = (emoji: string) => setValue((v) => v + emoji);

  return (
    <div className="input-pill items-center gap-2 px-3 md:px-5 py-2 md:py-3">
      <button
        type="button"
        onClick={openFileDialog}
        className="btn-icon shrink-0 w-8 h-8 text-[var(--foreground-secondary)]"
        title="Datei/Bild anhängen"
        disabled={sending || disabled}
      >
        <Plus size={18} />
      </button>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
        className="hidden"
        onChange={handleFilesSelected}
      />

      <div className="relative flex-1">
        <textarea
          ref={textareaRef}
          className="w-full h-10 md:h-9 max-h-[160px] resize-none outline-none text-[14px] md:text-[15px] leading-[1.4] py-2 bg-transparent text-[var(--foreground)] placeholder:text-[var(--foreground-secondary)]"
          placeholder={placeholder || "Nachricht schreiben…"}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={() => setTimeout(() => setMentionOpen(false), 150)}
          disabled={sending || disabled}
        />

        {mentionOpen && filteredMembers.length > 0 && (
          <div className="card-surface absolute bottom-full left-0 mb-1 z-50 w-56 max-h-48 overflow-y-auto p-1">
            {filteredMembers.map((m, i) => (
              <button
                key={m.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectMention(m)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-sm transition ${
                  i === mentionIndex
                    ? "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]"
                    : "text-[var(--foreground)] hover:bg-[var(--border-subtle)]"
                }`}
              >
                <AtSign size={14} className="shrink-0 text-[var(--foreground-secondary)]" />
                <span className="truncate">{m.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative">
        <button
          ref={emojiBtnRef}
          type="button"
          onClick={() => setShowEmoji((s) => !s)}
          className="btn-icon shrink-0 w-8 h-8 text-[var(--foreground-secondary)]"
          title="Emoji einfügen"
          disabled={sending || disabled}
        >
          <Smile size={18} />
        </button>

        {showEmoji && (
          <div ref={emojiRef} className="absolute bottom-11 right-0 z-50">
            <EmojiPicker
              onSelect={(e) => {
                addEmoji(e);
                setShowEmoji(false);
              }}
            />
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={handleSend}
        disabled={!canSend}
        className="cursor-pointer ml-1 shrink-0 inline-flex items-center justify-center w-9 h-9 md:w-10 md:h-10 rounded-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] active:scale-95 transition text-white disabled:opacity-50"
        title="Senden"
      >
        <ArrowUp size={18} />
      </button>
    </div>
  );
}
