import {
  ArrowLeft,
  BriefcaseBusiness,
  Camera,
  ChevronRight,
  CloudUpload,
  Contact,
  Crop,
  LogIn,
  Menu,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  User,
  X,
} from "lucide-react";
import { ChangeEvent, FormEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";

type Side = "front" | "back";
type RecognitionSide = Side;
type View = "list" | "detail";
type SortMode = "time" | "name" | "company";

type CropDraft = {
  side: Side;
  file: File;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type CropHandle = "move" | "nw" | "ne" | "sw" | "se";

type SavedCard = {
  id: string;
  displayName: string;
  nameZh?: string;
  nameEn?: string;
  company: string;
  companyZh?: string;
  companyEn?: string;
  department?: string;
  departmentZh?: string;
  departmentEn?: string;
  title?: string;
  titleZh?: string;
  titleEn?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  fax?: string;
  website?: string;
  addressZh?: string;
  addressEn?: string;
  note?: string;
  frontUrl: string;
  backUrl: string;
  googleSyncStatus: string;
  aiConfidence?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

type CardForm = {
  nameZh: string;
  nameEn: string;
  companyZh: string;
  companyEn: string;
  departmentZh: string;
  departmentEn: string;
  titleZh: string;
  titleEn: string;
  email: string;
  phone: string;
  mobile: string;
  fax: string;
  website: string;
  addressZh: string;
  addressEn: string;
  note: string;
};

const emptyForm: CardForm = {
  nameZh: "",
  nameEn: "",
  companyZh: "",
  companyEn: "",
  departmentZh: "",
  departmentEn: "",
  titleZh: "",
  titleEn: "",
  email: "",
  phone: "",
  mobile: "",
  fax: "",
  website: "",
  addressZh: "",
  addressEn: "",
  note: "",
};

export function App() {
  const [view, setView] = useState<View>("list");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [images, setImages] = useState<Record<Side, File | null>>({
    front: null,
    back: null,
  });
  const [cropDraft, setCropDraft] = useState<CropDraft | null>(null);
  const [form, setForm] = useState<CardForm>(emptyForm);
  const [cards, setCards] = useState<SavedCard[]>([]);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("time");
  const [query, setQuery] = useState("");
  const [googleLabel, setGoogleLabel] = useState("工作聯絡人");
  const [googleConnected, setGoogleConnected] = useState(false);
  const [loadingCards, setLoadingCards] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [recognitionSide, setRecognitionSide] = useState<RecognitionSide | null>(null);
  const [syncingGoogle, setSyncingGoogle] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  const [syncStage, setSyncStage] = useState("");
  const [recognitionProgress, setRecognitionProgress] = useState(0);
  const [recognitionStage, setRecognitionStage] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const previews = useMemo(
    () => ({
      front: images.front ? URL.createObjectURL(images.front) : "",
      back: images.back ? URL.createObjectURL(images.back) : "",
    }),
    [images],
  );

  const editingCard = cards.find((card) => card.id === editingCardId);
  const visibleCards = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? cards.filter((card) =>
          [
            card.displayName,
            card.nameZh,
            card.nameEn,
            card.company,
            card.companyZh,
            card.companyEn,
            card.department,
            card.departmentZh,
            card.departmentEn,
            card.title,
            card.titleZh,
            card.titleEn,
            card.email,
            card.phone,
            card.mobile,
            card.fax,
            card.website,
            card.addressZh,
            card.addressEn,
            card.note,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
      : cards;

    return [...filtered].sort((a, b) => {
      if (sortMode === "name") {
        return cardTitle(a).localeCompare(cardTitle(b), "zh-Hant");
      }
      if (sortMode === "company") {
        return companyTitle(a).localeCompare(companyTitle(b), "zh-Hant");
      }
      return (b.createdAt || "").localeCompare(a.createdAt || "");
    });
  }, [cards, query, sortMode]);

  useEffect(() => {
    void loadCards();
    void loadGoogleStatus();

    const params = new URLSearchParams(window.location.search);
    const google = params.get("google");
    if (google) {
      setStatus(google === "connected" ? "Google 已登入" : `Google 登入未完成：${google}`);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  async function loadCards() {
    setLoadingCards(true);
    try {
      const response = await fetch("/api/cards");
      if (!response.ok) {
        throw new Error("讀取名片清單失敗。");
      }
      const payload = (await response.json()) as { cards: SavedCard[] };
      setCards(payload.cards.map(normalizeCardUrls));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "讀取名片清單失敗。");
    } finally {
      setLoadingCards(false);
    }
  }

  async function loadGoogleStatus() {
    try {
      const response = await fetch("/api/google/status");
      const payload = (await response.json()) as { connected?: boolean };
      setGoogleConnected(Boolean(payload.connected));
    } catch {
      setGoogleConnected(false);
    }
  }

  function startNewCard() {
    setEditingCardId(null);
    setImages({ front: null, back: null });
    setForm(emptyForm);
    setStatus("");
    setError("");
    setView("detail");
    scrollToTop();
  }

  function openCard(card: SavedCard) {
    setEditingCardId(card.id);
    setImages({ front: null, back: null });
    setForm({
      nameZh: card.nameZh ?? "",
      nameEn: card.nameEn ?? "",
      companyZh: card.companyZh ?? "",
      companyEn: card.companyEn ?? "",
      departmentZh: card.departmentZh ?? "",
      departmentEn: card.departmentEn ?? "",
      titleZh: card.titleZh ?? "",
      titleEn: card.titleEn ?? "",
      email: card.email ?? "",
      phone: card.phone ?? "",
      mobile: card.mobile ?? "",
      fax: card.fax ?? "",
      website: card.website ?? "",
      addressZh: card.addressZh ?? "",
      addressEn: card.addressEn ?? "",
      note: card.note ?? "",
    });
    setStatus("");
    setError("");
    setView("detail");
  }

  function backToList() {
    setView("list");
    setEditingCardId(null);
    setImages({ front: null, back: null });
    setForm(emptyForm);
    setError("");
  }

  function handleImage(side: Side, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (file) {
      setCropDraft({
        side,
        file,
        url: URL.createObjectURL(file),
        x: 4,
        y: 12,
        width: 92,
        height: 58,
      });
    }
    setStatus("");
    setError("");
    event.target.value = "";
  }

  function updateField(field: keyof CardForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function saveCard(event: FormEvent) {
    event.preventDefault();
    setError("");
    setStatus("");

    if (!editingCardId && !hasAnyImage(images)) {
      showError("請先加入至少一張名片照片。");
      return;
    }

    setSaving(true);
    try {
      const response = editingCardId
        ? await updateCard()
        : await createCard();

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? "儲存失敗。");
      }

      await response.json();
      setStatus("名片已儲存");
      await loadCards();
      backToList();
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : "儲存失敗。");
    } finally {
      setSaving(false);
    }
  }

  async function createCard() {
    const body = new FormData();
    if (images.front) {
      body.set("frontImage", images.front);
    }
    if (images.back) {
      body.set("backImage", images.back);
    }
    body.set("card", JSON.stringify(form));

    return fetch("/api/cards", {
      method: "POST",
      body,
    });
  }

  async function updateCard() {
    if (!editingCardId) {
      throw new Error("缺少名片 ID。");
    }

    if (!hasAnyImage(images)) {
      return fetch(`/api/cards/${editingCardId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
    }

    const body = new FormData();
    if (images.front) {
      body.set("frontImage", images.front);
    }
    if (images.back) {
      body.set("backImage", images.back);
    }
    body.set("card", JSON.stringify(form));

    return fetch(`/api/cards/${editingCardId}`, {
      method: "PUT",
      body,
    });
  }

  async function applyCrop() {
    if (!cropDraft) {
      return;
    }

    const cropped = await cropImage(cropDraft);
    setImages((current) => ({
      ...current,
      [cropDraft.side]: cropped,
    }));
    setCropDraft(null);
  }

  function useOriginalImage() {
    if (!cropDraft) {
      return;
    }
    setImages((current) => ({
      ...current,
      [cropDraft.side]: cropDraft.file,
    }));
    setCropDraft(null);
  }

  async function deleteCurrentCard() {
    if (!editingCardId) {
      backToList();
      return;
    }
    setDeleteDialogOpen(true);
  }

  async function confirmDeleteCurrentCard(deleteGoogle: boolean) {
    if (!editingCardId) {
      return;
    }

    setDeleting(true);
    setDeleteDialogOpen(false);
    setError("");
    try {
      const query = deleteGoogle ? "?google=delete" : "";
      const response = await fetch(`/api/cards/${editingCardId}${query}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? "刪除失敗。");
      }
      setStatus(deleteGoogle ? "名片與 Google 聯絡人已刪除" : "名片已從本機刪除");
      await loadCards();
      backToList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "刪除失敗。");
    } finally {
      setDeleting(false);
    }
  }

  async function recognizeCurrentCard(side: RecognitionSide) {
    if (!editingCardId && !images[side]) {
      showError(`請先加入名片${side === "front" ? "正面" : "背面"}照片。`);
      return;
    }

    setRecognizing(true);
    setRecognitionSide(side);
    setRecognitionProgress(8);
    setRecognitionStage(side === "front" ? "準備辨識正面" : "準備辨識背面");
    setError("");
    setStatus("");
    try {
      let cardId = editingCardId;

      if (!cardId) {
        setRecognitionProgress(18);
        setRecognitionStage("上傳名片");
        const createResponse = await createCard();
        const created = (await createResponse.json().catch(() => null)) as
          | SavedCard
          | { error?: string }
          | null;

        if (!createResponse.ok || !created || !("id" in created)) {
          throw new Error(
            created && "error" in created ? created.error ?? "建立名片失敗。" : "建立名片失敗。",
          );
        }

        const normalized = normalizeCardUrls(created);
        cardId = normalized.id;
        setEditingCardId(cardId);
        setCards((current) => [normalized, ...current]);
        setImages({ front: null, back: null });
        setRecognitionProgress(36);
        setRecognitionStage("名片已儲存");
      } else if (images[side]) {
        setRecognitionProgress(42);
        setRecognitionStage(side === "front" ? "上傳新的正面照片" : "上傳新的背面照片");
        const uploadedSides = {
          front: Boolean(images.front),
          back: Boolean(images.back),
        };
        const updateResponse = await updateCard();
        const updated = (await updateResponse.json().catch(() => null)) as
          | SavedCard
          | { error?: string }
          | null;

        if (!updateResponse.ok || !updated || !("id" in updated)) {
          throw new Error(
            updated && "error" in updated ? updated.error ?? "更新名片照片失敗。" : "更新名片照片失敗。",
          );
        }

        const normalized = normalizeCardUrls(updated);
        setCards((current) => current.map((card) => card.id === normalized.id ? normalized : card));
        setImages((current) => ({
          front: uploadedSides.front ? null : current.front,
          back: uploadedSides.back ? null : current.back,
        }));
        setRecognitionProgress(50);
        setRecognitionStage(side === "front" ? "新的正面照片已上傳" : "新的背面照片已上傳");
      }

      setRecognitionProgress(58);
      setRecognitionStage(`OpenAI ${side === "front" ? "正面" : "背面"}辨識中`);
      const params = new URLSearchParams({ side });
      const response = await fetch(`/api/cards/${cardId}/recognize?${params.toString()}`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as
        | { card?: SavedCard; error?: string; provider?: string; model?: string }
        | null;

      if (!response.ok || !payload?.card) {
        throw new Error(`OpenAI 辨識失敗：${payload?.error ?? "請稍後再試。"}`);
      }

      const card = normalizeCardUrls(payload.card);
      const engineLabel = "OpenAI Vision";
      setRecognitionProgress(88);
      setRecognitionStage("整理欄位");
      setForm((current) => side === "back" ? mergeEnglishFields(current, card) : formFromCard(card));
      setRecognitionProgress(100);
      setRecognitionStage("辨識完成");
      setStatus(
        side === "back"
          ? `${engineLabel} 已辨識背面英文欄位，確認後請按儲存`
          : `${engineLabel} 已辨識正面並填入表單，確認後請按儲存`,
      );
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : "辨識失敗。");
    } finally {
      setRecognizing(false);
      setRecognitionSide(null);
      window.setTimeout(() => {
        setRecognitionProgress(0);
        setRecognitionStage("");
      }, 900);
    }
  }

  async function syncGoogle() {
    setError("");
    setStatus("");
    setSyncingGoogle(true);
    setSyncProgress(18);
    setSyncStage("準備同步到 Google");
    setDrawerOpen(false);
    setView("list");
    try {
      setSyncProgress(38);
      setSyncStage("連線 Google Contacts");
      const response = await fetch("/api/google/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: googleLabel }),
      });
      setSyncProgress(72);
      setSyncStage("整理同步結果");
      const payload = (await response.json().catch(() => null)) as
        | { created?: number; updated?: number; error?: string; errors?: Array<{ error: string }> }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "同步尚未啟用。");
      }
      if (payload?.errors?.length) {
        setStatus(`同步完成，但有 ${payload.errors.length} 筆失敗`);
      } else {
        setStatus(`已同步到 Google：新增 ${payload?.created ?? 0}，更新 ${payload?.updated ?? 0}`);
      }
      setSyncProgress(92);
      setSyncStage("更新名片清單");
      await loadGoogleStatus();
      await loadCards();
      setSyncProgress(100);
      setSyncStage("同步完成");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "同步尚未啟用。");
    } finally {
      setSyncingGoogle(false);
      window.setTimeout(() => {
        setSyncProgress(0);
        setSyncStage("");
      }, 900);
    }
  }

  function loginGoogle() {
    window.location.href = "/api/google/login";
  }

  function showError(message: string) {
    setError(message);
    window.setTimeout(() => {
      document.querySelector(".status.error")?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 0);
  }

  return (
    <main className="app-shell">
      {view === "list" ? (
        <ListView
          cards={visibleCards}
          loading={loadingCards}
          query={query}
          sortMode={sortMode}
          status={status}
          error={error}
          syncingGoogle={syncingGoogle}
          syncProgress={syncProgress}
          syncStage={syncStage}
          onMenu={() => setDrawerOpen(true)}
          onQuery={setQuery}
          onSort={setSortMode}
          onOpenCard={openCard}
          onNewCard={startNewCard}
        />
      ) : (
        <DetailView
          cards={cards}
          form={form}
          images={images}
          previews={previews}
          editingCard={editingCard}
          saving={saving}
          deleting={deleting}
          recognizing={recognizing}
          recognitionSide={recognitionSide}
          recognitionProgress={recognitionProgress}
          recognitionStage={recognitionStage}
          status={status}
          error={error}
          onBack={backToList}
          onField={updateField}
          onImage={handleImage}
          onSave={saveCard}
          onDelete={deleteCurrentCard}
          onRecognizeSide={recognizeCurrentCard}
        />
      )}

      {cropDraft ? (
        <CropSheet
          draft={cropDraft}
          onChange={setCropDraft}
          onCancel={() => setCropDraft(null)}
          onOriginal={useOriginalImage}
          onApply={applyCrop}
        />
      ) : null}

      {deleteDialogOpen ? (
        <DeleteChoiceDialog
          card={editingCard}
          deleting={deleting}
          onCancel={() => setDeleteDialogOpen(false)}
          onDeleteLocal={() => void confirmDeleteCurrentCard(false)}
          onDeleteGoogle={() => void confirmDeleteCurrentCard(true)}
        />
      ) : null}

      <SettingsDrawer
        open={drawerOpen}
        label={googleLabel}
        connected={googleConnected}
        syncing={syncingGoogle}
        onClose={() => setDrawerOpen(false)}
        onLabel={setGoogleLabel}
        onLogin={loginGoogle}
        onSync={syncGoogle}
      />
    </main>
  );
}

function CropSheet({
  draft,
  onChange,
  onCancel,
  onOriginal,
  onApply,
}: {
  draft: CropDraft;
  onChange: (draft: CropDraft) => void;
  onCancel: () => void;
  onOriginal: () => void;
  onApply: () => void;
}) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    handle: CropHandle;
    pointerId: number;
    startX: number;
    startY: number;
    startDraft: CropDraft;
  } | null>(null);

  function startDrag(handle: CropHandle, event: PointerEvent<HTMLElement>) {
    const preview = previewRef.current;
    if (!preview) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    preview.setPointerCapture(event.pointerId);
    dragRef.current = {
      handle,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startDraft: draft,
    };
  }

  function dragCrop(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const preview = previewRef.current;
    if (!drag || !preview || drag.pointerId !== event.pointerId) {
      return;
    }

    const bounds = preview.getBoundingClientRect();
    const dx = ((event.clientX - drag.startX) / bounds.width) * 100;
    const dy = ((event.clientY - drag.startY) / bounds.height) * 100;
    onChange(resizeCrop(drag.startDraft, drag.handle, dx, dy));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div className="crop-shell" role="dialog" aria-modal="true">
      <div className="crop-card">
        <header className="crop-header">
          <div>
            <Crop size={20} />
            <strong>裁切{draft.side === "front" ? "正面" : "背面"}</strong>
          </div>
          <button className="icon-button" type="button" aria-label="關閉裁切" onClick={onCancel}>
            <X size={20} />
          </button>
        </header>

        <div
          className="crop-preview"
          ref={previewRef}
          onPointerMove={dragCrop}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <img src={draft.url} alt="裁切預覽" />
          <div
            className="crop-box"
            onPointerDown={(event) => startDrag("move", event)}
            style={{
              left: `${draft.x}%`,
              top: `${draft.y}%`,
              width: `${draft.width}%`,
              height: `${draft.height}%`,
            }}
          >
            <span className="crop-grid-line horizontal top" />
            <span className="crop-grid-line horizontal bottom" />
            <span className="crop-grid-line vertical left" />
            <span className="crop-grid-line vertical right" />
            <button
              className="crop-handle nw"
              type="button"
              aria-label="拖曳左上角裁切框"
              onPointerDown={(event) => startDrag("nw", event)}
            />
            <button
              className="crop-handle ne"
              type="button"
              aria-label="拖曳右上角裁切框"
              onPointerDown={(event) => startDrag("ne", event)}
            />
            <button
              className="crop-handle sw"
              type="button"
              aria-label="拖曳左下角裁切框"
              onPointerDown={(event) => startDrag("sw", event)}
            />
            <button
              className="crop-handle se"
              type="button"
              aria-label="拖曳右下角裁切框"
              onPointerDown={(event) => startDrag("se", event)}
            />
          </div>
        </div>

        <div className="crop-actions">
          <button className="secondary-dock-action" type="button" onClick={onOriginal}>
            使用原圖
          </button>
          <button className="primary-action" type="button" onClick={onApply}>
            套用裁切
          </button>
        </div>
      </div>
    </div>
  );
}

function resizeCrop(draft: CropDraft, handle: CropHandle, dx: number, dy: number): CropDraft {
  const minSize = 12;
  let { x, y, width, height } = draft;

  if (handle === "move") {
    return {
      ...draft,
      x: clamp(draft.x + dx, 0, 100 - draft.width),
      y: clamp(draft.y + dy, 0, 100 - draft.height),
    };
  }

  if (handle.includes("w")) {
    const nextX = clamp(x + dx, 0, x + width - minSize);
    width += x - nextX;
    x = nextX;
  }

  if (handle.includes("e")) {
    width = clamp(width + dx, minSize, 100 - x);
  }

  if (handle.includes("n")) {
    const nextY = clamp(y + dy, 0, y + height - minSize);
    height += y - nextY;
    y = nextY;
  }

  if (handle.includes("s")) {
    height = clamp(height + dy, minSize, 100 - y);
  }

  return { ...draft, x, y, width, height };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function ListView({
  cards,
  loading,
  query,
  sortMode,
  status,
  error,
  syncingGoogle,
  syncProgress,
  syncStage,
  onMenu,
  onQuery,
  onSort,
  onOpenCard,
  onNewCard,
}: {
  cards: SavedCard[];
  loading: boolean;
  query: string;
  sortMode: SortMode;
  status: string;
  error: string;
  syncingGoogle: boolean;
  syncProgress: number;
  syncStage: string;
  onMenu: () => void;
  onQuery: (query: string) => void;
  onSort: (sortMode: SortMode) => void;
  onOpenCard: (card: SavedCard) => void;
  onNewCard: () => void;
}) {
  const groupedCards = useMemo(() => groupCardsForIndex(cards, sortMode), [cards, sortMode]);

  return (
    <section className="screen">
      <header className="app-bar">
        <button className="icon-button" type="button" aria-label="設定" onClick={onMenu}>
          <Menu size={22} />
        </button>
        <div className="app-title">
          <h1>名片清單</h1>
          <span>{cards.length} 張名片</span>
        </div>
        <label className="sort-control" aria-label="排序方式">
          <SlidersHorizontal size={18} />
          <select value={sortMode} onChange={(event) => onSort(event.target.value as SortMode)}>
            <option value="time">時間</option>
            <option value="name">姓名</option>
            <option value="company">公司</option>
          </select>
        </label>
      </header>

      <label className="search-box">
        <Search size={19} />
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="搜尋姓名、公司、電話、Email"
        />
      </label>

      {error ? <p className="status error">{error}</p> : null}
      {status ? <p className="status success">{status}</p> : null}
      {syncingGoogle ? (
        <div className="sync-panel" role="status" aria-live="polite">
          <RefreshCw size={22} />
          <div>
            <strong>{syncStage || "同步中"}</strong>
            <span>{syncProgress}%</span>
          </div>
          <progress value={syncProgress} max={100} />
        </div>
      ) : null}

      <div className="list-with-index">
        <div className="cards">
          {loading ? <p className="muted">讀取中</p> : null}
          {!loading && cards.length === 0 ? (
            <div className="empty-state">
              <Contact size={34} />
              <strong>尚未有名片</strong>
            </div>
          ) : null}
          {groupedCards.map((group) => (
            <section className="card-group" id={group.id} key={group.id}>
              <h2>{group.label}</h2>
              {group.cards.map((card) => (
                <button className="card-row" key={card.id} type="button" onClick={() => onOpenCard(card)}>
                  <LazyCardImage src={card.frontUrl} alt={`${cardTitle(card)}正面`} />
                  <div>
                    <strong>{cardTitle(card)}</strong>
                    <span>{[companyTitle(card), departmentTitle(card), titleText(card)].filter(Boolean).join(" · ") || "尚未填資料"}</span>
                    <span>{[card.email, card.mobile || card.phone].filter(Boolean).join(" · ")}</span>
                  </div>
                  <ChevronRight size={20} />
                </button>
              ))}
            </section>
          ))}
        </div>

        {groupedCards.length > 1 ? (
          <nav className="index-rail" aria-label="名片快速索引">
            {groupedCards.map((group) => (
              <button key={group.id} type="button" onClick={() => scrollToGroup(group.id)}>
                {group.shortLabel}
              </button>
            ))}
          </nav>
        ) : null}
      </div>

      <button className="fab" type="button" aria-label="新增名片" onClick={onNewCard}>
        <Plus size={26} />
      </button>
    </section>
  );
}

function LazyCardImage({ src, alt }: { src: string; alt: string }) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    if (shouldLoad) {
      return;
    }

    const image = imageRef.current;
    if (!image || !("IntersectionObserver" in window)) {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px 0px" },
    );

    observer.observe(image);
    return () => observer.disconnect();
  }, [shouldLoad]);

  return (
    <img
      ref={imageRef}
      className="card-thumbnail"
      src={shouldLoad ? src : undefined}
      alt={alt}
      loading="lazy"
      decoding="async"
    />
  );
}

function DetailView({
  cards,
  form,
  images,
  previews,
  editingCard,
  saving,
  deleting,
  recognizing,
  recognitionSide,
  recognitionProgress,
  recognitionStage,
  status,
  error,
  onBack,
  onField,
  onImage,
  onSave,
  onDelete,
  onRecognizeSide,
}: {
  cards: SavedCard[];
  form: CardForm;
  images: Record<Side, File | null>;
  previews: Record<Side, string>;
  editingCard?: SavedCard;
  saving: boolean;
  deleting: boolean;
  recognizing: boolean;
  recognitionSide: RecognitionSide | null;
  recognitionProgress: number;
  recognitionStage: string;
  status: string;
  error: string;
  onBack: () => void;
  onField: (field: keyof CardForm, value: string) => void;
  onImage: (side: Side, event: ChangeEvent<HTMLInputElement>) => void;
  onSave: (event: FormEvent) => void;
  onDelete: () => void;
  onRecognizeSide: (side: RecognitionSide) => void;
}) {
  const canRecognizeFront = Boolean(editingCard || images.front);
  const canRecognizeBack = Boolean(editingCard || images.back);
  const companyZhSuggestions = useMemo(() => collectCompanySuggestions(cards, "zh"), [cards]);
  const companyEnSuggestions = useMemo(() => collectCompanySuggestions(cards, "en"), [cards]);

  return (
    <form className="screen detail-screen" onSubmit={onSave}>
      <header className="app-bar">
        <button className="icon-button" type="button" aria-label="回清單" onClick={onBack}>
          <ArrowLeft size={22} />
        </button>
        <div className="app-title">
          <h1>{editingCard ? "編輯名片" : "新增名片"}</h1>
          <span>{editingCard ? cardTitle(editingCard) : "拍攝正反面"}</span>
        </div>
        <button className="icon-button" type="submit" aria-label="儲存" disabled={saving}>
          <Save size={21} />
        </button>
      </header>

      <section className="capture-grid" aria-label="名片圖片">
        <ImagePicker
          label="正面"
          side="front"
          preview={previews.front || editingCard?.frontUrl || ""}
          buttonLabel="辨識正面"
          recognizing={recognizing && recognitionSide === "front"}
          recognitionProgress={recognitionProgress}
          recognitionStage={recognitionStage}
          onChange={onImage}
          onRecognize={onRecognizeSide}
          recognizeDisabled={recognizing || !canRecognizeFront}
        />
        <ImagePicker
          label="背面"
          side="back"
          preview={previews.back || editingCard?.backUrl || ""}
          buttonLabel="補英文"
          recognizing={recognizing && recognitionSide === "back"}
          recognitionProgress={recognitionProgress}
          recognitionStage={recognitionStage}
          onChange={onImage}
          onRecognize={onRecognizeSide}
          recognizeDisabled={recognizing || !canRecognizeBack}
        />
      </section>

      <section className="editor" aria-label="聯絡人資料">
        <div className="section-heading">
          <User size={19} />
          <h2>聯絡資料</h2>
        </div>
        <div className="field-grid">
          <Field label="中文姓名" value={form.nameZh} onChange={(value) => onField("nameZh", value)} />
          <Field label="英文姓名" value={form.nameEn} onChange={(value) => onField("nameEn", value)} />
          <CompanyField
            label="中文公司"
            value={form.companyZh}
            suggestions={companyZhSuggestions}
            onChange={(value) => onField("companyZh", value)}
          />
          <CompanyField
            label="英文公司"
            value={form.companyEn}
            suggestions={companyEnSuggestions}
            onChange={(value) => onField("companyEn", value)}
          />
          <Field label="中文部門" value={form.departmentZh} onChange={(value) => onField("departmentZh", value)} />
          <Field label="英文部門" value={form.departmentEn} onChange={(value) => onField("departmentEn", value)} />
          <Field label="中文職稱" value={form.titleZh} onChange={(value) => onField("titleZh", value)} />
          <Field label="英文職稱" value={form.titleEn} onChange={(value) => onField("titleEn", value)} />
          <Field
            label="Email"
            value={form.email}
            inputMode="email"
            onChange={(value) => onField("email", value)}
          />
          <Field
            label="電話"
            value={form.phone}
            inputMode="tel"
            onChange={(value) => onField("phone", value)}
          />
          <Field
            label="手機"
            value={form.mobile}
            inputMode="tel"
            onChange={(value) => onField("mobile", value)}
          />
          <Field
            label="傳真"
            value={form.fax}
            inputMode="tel"
            onChange={(value) => onField("fax", value)}
          />
          <Field
            label="網站"
            value={form.website}
            inputMode="url"
            onChange={(value) => onField("website", value)}
          />
        </div>
        <label className="textarea-field">
          <span>中文地址</span>
          <textarea value={form.addressZh} onChange={(event) => onField("addressZh", event.target.value)} rows={3} />
        </label>
        <label className="textarea-field">
          <span>英文地址</span>
          <textarea value={form.addressEn} onChange={(event) => onField("addressEn", event.target.value)} rows={3} />
        </label>
        <label className="textarea-field">
          <span>備註</span>
          <textarea value={form.note} onChange={(event) => onField("note", event.target.value)} rows={4} />
        </label>
      </section>

      {error ? <p className="status error">{error}</p> : null}
      {status ? <p className="status success">{status}</p> : null}

      <footer className="action-dock">
        <button className="danger-action" type="button" onClick={onDelete} disabled={deleting}>
          <Trash2 size={20} />
          {deleting ? "刪除中" : "刪除"}
        </button>
        <button className="primary-action" type="submit" disabled={saving}>
          <CloudUpload size={21} />
          {saving ? "儲存中" : "儲存"}
        </button>
      </footer>
    </form>
  );
}

function SettingsDrawer({
  open,
  label,
  connected,
  syncing,
  onClose,
  onLabel,
  onLogin,
  onSync,
}: {
  open: boolean;
  label: string;
  connected: boolean;
  syncing: boolean;
  onClose: () => void;
  onLabel: (label: string) => void;
  onLogin: () => void;
  onSync: () => void;
}) {
  return (
    <>
      <div className={open ? "scrim open" : "scrim"} onClick={onClose} />
      <aside className={open ? "drawer open" : "drawer"} aria-hidden={!open}>
        <header className="drawer-header">
          <div>
            <Settings size={20} />
            <strong>設定</strong>
          </div>
          <button className="icon-button" type="button" aria-label="關閉" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <button className="drawer-item" type="button" onClick={onLogin}>
          <LogIn size={20} />
          <span>{connected ? "重新登入 Google 帳號" : "登入 Google 帳號"}</span>
        </button>
        <p className={connected ? "drawer-status connected" : "drawer-status"}>
          {connected ? "Google 已連線" : "尚未連線 Google"}
        </p>

        <label className="drawer-field">
          <span>
            <BriefcaseBusiness size={18} />
            Google 聯絡人標籤
          </span>
          <input value={label} onChange={(event) => onLabel(event.target.value)} />
        </label>

        <p className="drawer-status">視覺辨識使用伺服器端 OpenAI API；請在 Cloudflare Worker Secret 設定 OPENAI_API_KEY。</p>

        <button className="drawer-item primary-drawer" type="button" onClick={onSync} disabled={syncing}>
          <RefreshCw className={syncing ? "spinning-icon" : ""} size={20} />
          <span>{syncing ? "同步中" : "同步到 Google 聯絡人"}</span>
        </button>
      </aside>
    </>
  );
}

function DeleteChoiceDialog({
  card,
  deleting,
  onCancel,
  onDeleteLocal,
  onDeleteGoogle,
}: {
  card?: SavedCard;
  deleting: boolean;
  onCancel: () => void;
  onDeleteLocal: () => void;
  onDeleteGoogle: () => void;
}) {
  const canDeleteGoogle = card?.googleSyncStatus === "synced";

  return (
    <div className="delete-shell" role="presentation">
      <section className="delete-card" role="dialog" aria-modal="true" aria-labelledby="delete-title">
        <header>
          <strong id="delete-title">刪除名片</strong>
          <button className="icon-button" type="button" aria-label="取消刪除" onClick={onCancel} disabled={deleting}>
            <X size={20} />
          </button>
        </header>
        <p>
          {canDeleteGoogle
            ? "這張名片已同步到 Google，可以只刪本機，或連 Google 聯絡人一起刪。"
            : "這張名片尚未同步到 Google，將只刪除本機資料。"}
        </p>
        <div className={canDeleteGoogle ? "delete-actions has-google" : "delete-actions"}>
          <button type="button" className="secondary-dock-action" onClick={onCancel} disabled={deleting}>
            取消
          </button>
          <button type="button" className="danger-action" onClick={onDeleteLocal} disabled={deleting}>
            只刪本機
          </button>
          {canDeleteGoogle ? (
            <button type="button" className="danger-action delete-google-action" onClick={onDeleteGoogle} disabled={deleting}>
              連 Google 一起刪
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function ImagePicker({
  label,
  side,
  preview,
  buttonLabel,
  recognizing = false,
  recognitionProgress = 0,
  recognitionStage = "",
  onChange,
  onRecognize,
  recognizeDisabled = false,
}: {
  label: string;
  side: Side;
  preview: string;
  buttonLabel: string;
  recognizing?: boolean;
  recognitionProgress?: number;
  recognitionStage?: string;
  onChange: (side: Side, event: ChangeEvent<HTMLInputElement>) => void;
  onRecognize: (side: RecognitionSide) => void;
  recognizeDisabled?: boolean;
}) {
  return (
    <div className="image-picker-card">
      <label className="image-picker">
        <input type="file" accept="image/*" capture="environment" onChange={(event) => onChange(side, event)} />
        {preview ? (
          <img src={preview} alt={`名片${label}`} />
        ) : (
          <span className="empty-preview">
            <Camera size={28} />
            <span>{label}</span>
          </span>
        )}
        {recognizing ? (
          <span className="image-recognition" role="status" aria-live="polite">
            <span className="spinner" />
            <span>
              <strong>{recognitionStage || `${label}辨識中`}</strong>
              <span>{recognitionProgress}%</span>
            </span>
            <progress value={recognitionProgress} max={100} />
          </span>
        ) : null}
        <span className="image-caption">{label}</span>
      </label>
      <button
        className="image-recognize-button"
        type="button"
        onClick={() => onRecognize(side)}
        disabled={recognizeDisabled}
      >
        <Camera size={18} />
        {recognizing ? "辨識中" : buttonLabel}
      </button>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: "email" | "tel" | "url";
}) {
  return (
    <label className="text-field">
      <span>{label}</span>
      <input value={value} inputMode={inputMode} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function CompanyField({
  label,
  value,
  suggestions,
  onChange,
}: {
  label: string;
  value: string;
  suggestions: string[];
  onChange: (value: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const visibleSuggestions = filterCompanySuggestions(suggestions, value);

  return (
    <div className="text-field company-field">
      <label>
        <span>{label}</span>
        <input
          value={value}
          onBlur={() => setFocused(false)}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setFocused(true)}
        />
      </label>
      {focused && visibleSuggestions.length ? (
        <div className="company-suggestions" aria-label={`${label}建議`}>
          {visibleSuggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChange(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function cardTitle(card: SavedCard) {
  return card.displayName || card.nameZh || card.nameEn || card.company || card.companyZh || card.companyEn || "未命名名片";
}

function companyTitle(card: SavedCard) {
  return card.company || card.companyZh || card.companyEn || "";
}

function departmentTitle(card: SavedCard) {
  return card.department || card.departmentZh || card.departmentEn || "";
}

function titleText(card: SavedCard) {
  return card.title || card.titleZh || card.titleEn || "";
}

function scrollToTop() {
  window.setTimeout(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, 0);
}

function scrollToGroup(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function groupCardsForIndex(cards: SavedCard[], sortMode: SortMode) {
  const groups: Array<{ id: string; label: string; shortLabel: string; cards: SavedCard[] }> = [];
  for (const card of cards) {
    const label = cardIndexLabel(card, sortMode);
    const previous = groups[groups.length - 1];
    if (previous?.label === label) {
      previous.cards.push(card);
      continue;
    }
    groups.push({
      id: `card-group-${sortMode}-${groups.length}-${encodeURIComponent(label)}`,
      label,
      shortLabel: cardIndexShortLabel(label, sortMode),
      cards: [card],
    });
  }
  return groups;
}

function cardIndexLabel(card: SavedCard, sortMode: SortMode) {
  if (sortMode === "time") {
    const date = card.createdAt ? new Date(card.createdAt) : null;
    if (date && !Number.isNaN(date.getTime())) {
      return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}`;
    }
    return "未分類";
  }
  const source = sortMode === "company" ? companyTitle(card) : cardTitle(card);
  return source.trim().charAt(0).toUpperCase() || "#";
}

function cardIndexShortLabel(label: string, sortMode: SortMode) {
  return sortMode === "time" && /^\d{4}\/\d{2}$/.test(label) ? label.slice(5) : label;
}

function collectCompanySuggestions(cards: SavedCard[], language: "zh" | "en") {
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const card of cards) {
    const values = language === "zh"
      ? [card.companyZh, looksChineseText(card.company) ? card.company : ""]
      : [card.companyEn, looksLatinText(card.company) ? card.company : ""];

    for (const value of values) {
      const normalized = value?.trim();
      if (!normalized || seen.has(normalizeCompanySuggestion(normalized))) {
        continue;
      }
      seen.add(normalizeCompanySuggestion(normalized));
      suggestions.push(normalized);
    }
  }
  return suggestions;
}

function filterCompanySuggestions(suggestions: string[], value: string) {
  const query = normalizeCompanySuggestion(value);
  return suggestions
    .filter((suggestion) => {
      const normalized = normalizeCompanySuggestion(suggestion);
      return !query || normalized.includes(query) || query.includes(normalized);
    })
    .slice(0, 6);
}

function normalizeCompanySuggestion(value: string) {
  return value.toLowerCase().replace(/[\s　.,，。()（）-]/g, "");
}

function looksChineseText(value?: string) {
  return Boolean(value && /[\u3400-\u9fff]/.test(value));
}

function looksLatinText(value?: string) {
  return Boolean(value && /[A-Za-z]/.test(value) && !looksChineseText(value));
}

function formFromCard(card: SavedCard): CardForm {
  return {
    nameZh: card.nameZh ?? "",
    nameEn: card.nameEn ?? "",
    companyZh: card.companyZh ?? "",
    companyEn: card.companyEn ?? "",
    departmentZh: card.departmentZh ?? "",
    departmentEn: card.departmentEn ?? "",
    titleZh: card.titleZh ?? "",
    titleEn: card.titleEn ?? "",
    email: card.email ?? "",
    phone: card.phone ?? "",
    mobile: card.mobile ?? "",
    fax: card.fax ?? "",
    website: card.website ?? "",
    addressZh: card.addressZh ?? "",
    addressEn: card.addressEn ?? "",
    note: card.note ?? "",
  };
}

function mergeEnglishFields(current: CardForm, card: SavedCard): CardForm {
  return {
    ...current,
    nameEn: card.nameEn || current.nameEn,
    companyEn: card.companyEn || current.companyEn,
    departmentEn: card.departmentEn || current.departmentEn,
    titleEn: card.titleEn || current.titleEn,
    addressEn: card.addressEn || current.addressEn,
  };
}

function normalizeCardUrls(card: SavedCard): SavedCard {
  return {
    ...card,
    frontUrl: normalizeImageUrl(card.frontUrl),
    backUrl: normalizeImageUrl(card.backUrl),
  };
}

function normalizeImageUrl(url: string) {
  if (url.startsWith("/")) {
    return url;
  }

  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function hasAnyImage(images: Record<Side, File | null>) {
  return Boolean(images.front || images.back);
}

async function cropImage(draft: CropDraft): Promise<File> {
  const image = await loadImage(draft.url);
  const canvas = document.createElement("canvas");
  const sourceX = (draft.x / 100) * image.naturalWidth;
  const sourceY = (draft.y / 100) * image.naturalHeight;
  const sourceWidth = (draft.width / 100) * image.naturalWidth;
  const sourceHeight = (draft.height / 100) * image.naturalHeight;
  const maxWidth = 1800;
  const scale = Math.min(1, maxWidth / sourceWidth);

  canvas.width = Math.round(sourceWidth * scale);
  canvas.height = Math.round(sourceHeight * scale);
  const context = canvas.getContext("2d");

  if (!context) {
    return draft.file;
  }

  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.9),
  );

  if (!blob) {
    return draft.file;
  }

  const name = draft.file.name.replace(/\.[^.]+$/, "") || draft.side;
  return new File([blob], `${name}-cropped.jpg`, { type: "image/jpeg" });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}
