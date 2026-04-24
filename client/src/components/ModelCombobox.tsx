import { useState, useRef, useEffect, useId } from "react";
import type { ModelOption } from "../lib/modelOptions";

export type { ModelOption };

type Props = {
  models: ModelOption[];
  modelId: string;
  onModelIdChange: (id: string) => void;
};

export function ModelCombobox({ models, modelId, onModelIdChange }: Props) {
  const baseId = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const known = models.find((m) => m.id === modelId);

  const filtered = models.filter(
    (m) =>
      m.label.toLowerCase().includes(q.toLowerCase()) ||
      m.id.toLowerCase().includes(q.toLowerCase())
  );

  const display = known
    ? known.label
    : modelId
      ? `Custom: ${modelId}`
      : "Pick a model or type a name…";

  useEffect(() => {
    if (open) {
      setHl(0);
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <div className={`combobox-wrap${open ? " open" : ""}`} ref={wrap}>
      <div className="form-field" style={{ marginBottom: 0 }}>
        <label id={baseId + "-l"}>Model (search or pick)</label>
        <button
          type="button"
          className="combobox-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{display}</span>
          <span className="chevron" aria-hidden>
            ▼
          </span>
        </button>
        {open && (
          <div className="combobox-panel" role="listbox">
            <input
              ref={searchRef}
              className="combobox-search"
              placeholder="Type to search…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setHl(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHl((h) => Math.min(h + 1, Math.max(0, filtered.length - 1)));
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHl((h) => Math.max(0, h - 1));
                }
                if (e.key === "Enter" && filtered[hl]) {
                  e.preventDefault();
                  onModelIdChange(filtered[hl].id);
                  setQ("");
                  setOpen(false);
                }
                if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
            />
            <div className="combobox-list">
              {filtered.length === 0 && (
                <p className="hint" style={{ padding: "0.5rem" }}>
                  No list matches. Use the custom field below, or try another search.
                </p>
              )}
              {filtered.map((m, i) => (
                <button
                  type="button"
                  key={m.id + i}
                  className={"combobox-option" + (i === hl ? " hl" : "")}
                  onMouseEnter={() => setHl(i)}
                  onClick={() => {
                    onModelIdChange(m.id);
                    setQ("");
                    setOpen(false);
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="combobox-footer">Your API key type must match the model family.</div>
          </div>
        )}
      </div>
      <div className="custom-model-input" style={{ marginTop: "0.65rem" }}>
        <label htmlFor={baseId + "custom"}>Model name (required)</label>
        <input
          id={baseId + "custom"}
          type="text"
          value={modelId}
          onChange={(e) => onModelIdChange(e.target.value)}
          autoComplete="off"
          placeholder="Picked from list or type the exact name"
        />
        <p className="hint">You can use the list above, or type any name your key supports (including custom deployments).</p>
      </div>
    </div>
  );
}
