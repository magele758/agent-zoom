import { useState, type MouseEvent } from "react";
import {
  WORK_ORIGIN_LABELS,
  WORKSPACE_CATEGORIES,
  WORKSPACE_CATEGORY_LABELS,
  type WorkOriginTrack,
  type WorkspaceCategory,
  type WorkspaceClassification,
} from "../../src/workspace-classification-types";
import { request } from "./api";
import "./dual-track.css";

export function OriginTrackBadge({ track }: { track?: WorkOriginTrack }) {
  const value: WorkOriginTrack = track === "opc_dispatched" ? "opc_dispatched" : "founder_managed";
  return (
    <span
      className={`dt-pill dt-origin-${value}`}
      title={
        value === "opc_dispatched"
          ? "由 OPC OS 工作流、暗工厂或看板自动派发"
          : "由你在 Herdr 或本机终端自主安排与跟进"
      }
    >
      {value === "opc_dispatched" ? "⚙ " : "👤 "}
      {WORK_ORIGIN_LABELS[value]}
    </span>
  );
}

export function HerdrBadge({
  address,
  spaceName,
  subCount,
}: {
  address?: string | null;
  spaceName?: string | null;
  subCount?: number;
}) {
  if (!address) return null;
  return (
    <span
      className="dt-pill dt-herdr"
      title={`Herdr 终端 ${address}${spaceName ? ` · Space: ${spaceName}` : ""}`}
    >
      Herdr · {address}
      {spaceName ? ` (${spaceName})` : ""}
      {subCount && subCount > 0 ? ` +${subCount}子` : ""}
    </span>
  );
}

export function ClassificationBadge({
  classification,
  editable = false,
  onChanged,
}: {
  classification?: WorkspaceClassification;
  editable?: boolean;
  onChanged?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [category, setCategory] = useState<WorkspaceCategory>(classification?.category ?? "personal");
  const [groupName, setGroupName] = useState(classification?.group ?? "个人事项");

  if (!classification) return null;

  const openEditor = (e: MouseEvent) => {
    e.stopPropagation();
    if (!editable) return;
    setCategory(classification.category);
    setGroupName(classification.group);
    setEditing(true);
  };

  const handleSave = async (e: MouseEvent) => {
    e.stopPropagation();
    setSaving(true);
    try {
      await request("/api/opc/classifications", {
        method: "POST",
        body: JSON.stringify({
          key: classification.key,
          category,
          groupName: groupName.trim() || WORKSPACE_CATEGORY_LABELS[category],
          canonicalProject: classification.canonicalProject,
        }),
      });
      setEditing(false);
      onChanged?.();
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <span className="dt-classify-editor" onClick={(e) => e.stopPropagation()}>
        <select
          aria-label="选择一级归属"
          value={category}
          disabled={saving}
          onChange={(e) => {
            const next = e.target.value as WorkspaceCategory;
            setCategory(next);
            setGroupName(WORKSPACE_CATEGORY_LABELS[next]);
          }}
        >
          {WORKSPACE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {WORKSPACE_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <input
          type="text"
          aria-label="分组名称"
          value={groupName}
          disabled={saving}
          placeholder="产品/分组名"
          onChange={(e) => setGroupName(e.target.value)}
        />
        <button type="button" className="dt-mini-btn primary" disabled={saving} onClick={(e) => void handleSave(e)}>
          {saving ? "保存…" : "保存"}
        </button>
        <button
          type="button"
          className="dt-mini-btn"
          disabled={saving}
          onClick={(e) => {
            e.stopPropagation();
            setEditing(false);
          }}
        >
          取消
        </button>
      </span>
    );
  }

  const label =
    classification.group && classification.group !== classification.categoryLabel
      ? `${classification.categoryLabel} · ${classification.group}`
      : classification.categoryLabel;

  return (
    <span
      className={`dt-pill dt-cat-${classification.category}${editable ? " is-editable" : ""}`}
      title={
        editable
          ? `当前归属：${label}（点击可修改归类并持久记住）`
          : `归属：${label}`
      }
      onClick={editable ? openEditor : undefined}
      role={editable ? "button" : undefined}
      tabIndex={editable ? 0 : undefined}
    >
      {label}
      {editable && <span className="dt-edit-hint"> ✎</span>}
    </span>
  );
}
