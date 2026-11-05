import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { label } from "./format.ts";
import type { FindingOutcome, RunState } from "./types.ts";

export type Sign = "add" | "remove" | "change" | "none";

/** One line of a diff: the gutter sign carries whether the fact is good or bad news. */
export function DiffLine({ sign, children }: { sign: Sign; children: ReactNode }) {
  const glyph = { add: "+", remove: "−", change: "~", none: " " }[sign];
  return (
    <li className={`diff-line diff-line--${sign}`}>
      <span className="diff-sign" aria-hidden="true">
        {glyph}
      </span>
      <span className="diff-text">{children}</span>
    </li>
  );
}

const RUN_SIGNS: Record<RunState, Sign> = {
  queued: "change",
  reviewing: "change",
  publishing: "change",
  completed: "add",
  partial: "change",
  failed: "remove",
  superseded: "none",
  skipped: "none",
};

const OUTCOME_SIGNS: Record<FindingOutcome, Sign> = {
  open: "remove",
  suspected_fixed: "change",
  unverifiable: "none",
  confirmed_fixed: "add",
  dismissed: "none",
};

export function Status({ sign, children }: { sign: Sign; children: ReactNode }) {
  return <span className={`status status--${sign}`}>{children}</span>;
}

export function RunStatus({ state }: { state: RunState | null }) {
  if (!state) return <Status sign="none">Not reviewed</Status>;
  return <Status sign={RUN_SIGNS[state]}>{label(state)}</Status>;
}

export function OutcomeStatus({ outcome }: { outcome: FindingOutcome }) {
  return <Status sign={OUTCOME_SIGNS[outcome]}>{label(outcome)}</Status>;
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function Drawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog ref={dialog} className="drawer" aria-label={title} onClose={onClose}>
      <header className="drawer-header">
        <h2>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="drawer-body">{children}</div>
    </dialog>
  );
}
