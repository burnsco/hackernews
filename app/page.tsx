"use client";

import { motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, memo, useMemo, useRef, useState } from "react";

const API_BASE = "https://hacker-news.firebaseio.com/v0";
const MAX_FRONT_PAGE_STORIES = 30;
const FETCH_CHUNK_SIZE = 15;
const MAX_COMMENT_DEPTH = 5;
const MAX_CHILDREN_PER_LEVEL = 10;
const PAGE_SIZE = 30;
const FEED_CACHE_TTL_MS = 60_000;
const USER_CACHE_TTL_MS = 5 * 60_000;
const POST_CACHE_TTL_MS = 2 * 60_000;

type Section = "top" | "new" | "past" | "comments" | "ask" | "show" | "jobs" | "submit";

type HNItem = {
  id: number;
  type?: "story" | "comment" | "job" | "poll" | "pollopt";
  by?: string;
  time?: number;
  title?: string;
  text?: string;
  url?: string;
  score?: number;
  descendants?: number;
  parent?: number;
  kids?: number[];
  dead?: boolean;
  deleted?: boolean;
};

type HNCommentNode = HNItem & {
  children: HNCommentNode[];
};

type HNUser = {
  id: string;
  created: number;
  about?: string;
  karma: number;
  submitted?: number[];
};

type LoadState = "idle" | "loading" | "ready" | "error";
type TimedValue<T> = {
  value: T;
  createdAt: number;
};
type FeedSnapshot = {
  ids: number[];
  items: HNItem[];
  nextFetchIndex: number;
};
type PostSnapshot = {
  item: HNItem;
  comments: HNCommentNode[];
};

const TAB_LINKS: Array<{ id: Exclude<Section, "top">; label: string }> = [
  { id: "new", label: "new" },
  { id: "past", label: "past" },
  { id: "comments", label: "comments" },
  { id: "ask", label: "ask" },
  { id: "show", label: "show" },
  { id: "jobs", label: "jobs" },
  { id: "submit", label: "submit" },
];

const textCache = new Map<string, string>();
const feedCache = new Map<Section, TimedValue<FeedSnapshot>>();
const userCache = new Map<string, TimedValue<HNUser>>();
const postCache = new Map<number, TimedValue<PostSnapshot>>();

function sectionPath(section: Section): string {
  return section === "top" ? "/" : `/?section=${section}`;
}

function normalizeSection(value: string | null | undefined): Section {
  if (
    value === "new" ||
    value === "past" ||
    value === "comments" ||
    value === "ask" ||
    value === "show" ||
    value === "jobs" ||
    value === "submit"
  ) {
    return value;
  }
  return "top";
}

function readTimedCache<K, T>(cache: Map<K, TimedValue<T>>, key: K, maxAgeMs: number): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > maxAgeMs) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeTimedCache<K, T>(cache: Map<K, TimedValue<T>>, key: K, value: T) {
  cache.set(key, { value, createdAt: Date.now() });
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

async function fetchItemById(id: number, signal: AbortSignal): Promise<HNItem | null> {
  const item = await fetchJson<HNItem | null>(`${API_BASE}/item/${id}.json`, signal);
  if (!item || typeof item.id !== "number") return null;
  return item;
}

async function fetchUserById(id: string, signal: AbortSignal): Promise<HNUser | null> {
  const user = await fetchJson<HNUser | null>(`${API_BASE}/user/${id}.json`, signal);
  if (!user || typeof user.id !== "string") return null;
  return user;
}

function formatRelativeAge(unixTimeSeconds?: number): string {
  if (!unixTimeSeconds) return "unknown";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, nowSeconds - unixTimeSeconds);
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatCalendarDate(unixTimeSeconds?: number): string {
  if (!unixTimeSeconds) return "Unknown date";
  return new Date(unixTimeSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function getDomain(url?: string): string {
  if (!url) return "news.ycombinator.com";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "news.ycombinator.com";
  }
}

function scrollToComments() {
  const commentsElement = document.getElementById("comments");
  commentsElement?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function toPlainText(value?: string): string {
  if (!value) return "";
  const cached = textCache.get(value);
  if (cached) return cached;

  let normalized = "";
  if (typeof window !== "undefined") {
    const doc = new DOMParser().parseFromString(value, "text/html");
    const text = (doc.body as HTMLElement).innerText || doc.body.textContent || "";
    normalized = text.replace(/\n{3,}/g, "\n\n").trim();
  } else {
    normalized = value
      .replace(/<[^>]+>/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  }

  textCache.set(value, normalized);
  return normalized;
}

async function fetchItemsByIds(
  ids: number[],
  signal: AbortSignal,
  maxItems = ids.length,
): Promise<HNItem[]> {
  const items: HNItem[] = [];
  for (
    let startIndex = 0;
    startIndex < ids.length && items.length < maxItems;
    startIndex += FETCH_CHUNK_SIZE
  ) {
    const chunk = ids.slice(startIndex, startIndex + FETCH_CHUNK_SIZE);
    const results = await Promise.all(
      chunk.map((id) => fetchItemById(id, signal).catch(() => null)),
    );
    for (const item of results) {
      if (!item || item.deleted || item.dead) continue;
      items.push(item);
      if (items.length === maxItems) break;
    }
  }
  return items;
}

function shouldRenderInSection(item: HNItem, section: Section): boolean {
  if (!item || item.dead || item.deleted) return false;
  if (section === "jobs") return item.type === "job";
  if (section === "comments") return item.type === "comment" && !!item.text;
  return item.type === "story" || item.type === "poll";
}

async function fetchFeedPage(
  ids: number[],
  section: Section,
  startIndex: number,
  signal: AbortSignal,
): Promise<{ items: HNItem[]; nextFetchIndex: number }> {
  let cursor = startIndex;
  const pageItems: HNItem[] = [];

  while (cursor < ids.length && pageItems.length < PAGE_SIZE) {
    const chunk = ids.slice(cursor, cursor + PAGE_SIZE);
    if (chunk.length === 0) break;
    cursor += PAGE_SIZE;

    const fetchedItems = await fetchItemsByIds(chunk, signal, chunk.length);
    for (const item of fetchedItems) {
      if (!shouldRenderInSection(item, section)) continue;
      pageItems.push(item);
      if (pageItems.length === PAGE_SIZE) break;
    }
  }

  return { items: pageItems, nextFetchIndex: cursor };
}

async function fetchStoryIds(section: Section, signal: AbortSignal): Promise<number[]> {
  if (section === "submit") return [];

  if (section === "comments") {
    const updates = await fetchJson<{ items?: number[] }>(`${API_BASE}/updates.json`, signal);
    return (updates.items ?? []).filter((id): id is number => typeof id === "number");
  }

  const endpoint =
    section === "new"
      ? "newstories"
      : section === "ask"
        ? "askstories"
        : section === "show"
          ? "showstories"
          : section === "jobs"
            ? "jobstories"
            : "topstories";

  const storyIds = await fetchJson<number[]>(`${API_BASE}/${endpoint}.json`, signal);
  return storyIds.filter((id): id is number => typeof id === "number");
}

async function buildCommentTree(
  ids: number[],
  signal: AbortSignal,
  depth = 0,
): Promise<HNCommentNode[]> {
  if (depth >= MAX_COMMENT_DEPTH || ids.length === 0) return [];
  const limitedIds = ids.slice(0, MAX_CHILDREN_PER_LEVEL);
  const results = await Promise.all(
    limitedIds.map((id) => fetchItemById(id, signal).catch(() => null)),
  );

  const validComments = results.filter(
    (item): item is HNItem => !!item && item.type === "comment" && !item.dead && !item.deleted,
  );

  const nodes = await Promise.all(
    validComments.map(async (item) => {
      const children = await buildCommentTree(item.kids ?? [], signal, depth + 1);
      return Object.assign({}, item, { children }) as HNCommentNode;
    }),
  );
  return nodes;
}

function FeedNav({ activeSection }: { activeSection: Section }) {
  return (
    <div className="sticky top-3 z-20 flex flex-wrap gap-2 rounded-3xl border border-white/15 bg-slate-950/85 p-3 shadow-[0_14px_40px_rgba(2,6,23,0.45)] backdrop-blur">
      <Link
        href="/"
        className="rounded-full border border-cyan-100/30 bg-cyan-300/8 px-4 py-1.5 text-xs uppercase tracking-[0.18em] text-cyan-100 transition hover:bg-cyan-300/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200/60"
      >
        home
      </Link>
      {TAB_LINKS.map((item) => {
        const isActive = activeSection === item.id;
        return (
          <Link
            key={item.id}
            href={sectionPath(item.id)}
            className={`rounded-full border px-4 py-1.5 text-xs uppercase tracking-[0.18em] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200/60 ${
              isActive
                ? "border-cyan-100/60 bg-cyan-300/25 text-cyan-50"
                : "border-cyan-100/30 bg-cyan-300/8 text-cyan-100 hover:bg-cyan-300/20"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}

function sectionLabel(section: Section): string {
  if (section === "top") return "Front Page";
  if (section === "ask") return "Ask HN";
  if (section === "show") return "Show HN";
  if (section === "comments") return "Recent Comments";
  return `${section.charAt(0).toUpperCase()}${section.slice(1)}`;
}

function FeedRowSkeleton() {
  return (
    <li className="p-4 border rounded-2xl border-white/10 bg-slate-900/80 animate-pulse">
      <div className="h-3 w-24 rounded-full bg-white/10" />
      <div className="mt-3 h-5 w-5/6 rounded-full bg-white/10" />
      <div className="mt-3 h-4 w-full rounded-full bg-white/5" />
      <div className="mt-2 h-4 w-2/3 rounded-full bg-white/5" />
    </li>
  );
}

type StoryListItemProps = {
  item: HNItem;
  index: number;
  section: Section;
  shouldReduceMotion: boolean;
  onOpenDetail: (path: string) => void;
};

const StoryListItem = memo(function StoryListItem({
  item,
  index,
  section,
  shouldReduceMotion,
  onOpenDetail,
}: StoryListItemProps) {
  const isComment = item.type === "comment";
  const title = isComment ? `Comment by ${item.by ?? "unknown"}` : (item.title ?? "Untitled story");
  const snippet = isComment ? toPlainText(item.text).slice(0, 180) : "";
  const detailPath = `/?post=${item.id}&from=${section}`;
  const externalUrl = item.url;
  const rank = section === "past" ? index + 1 + MAX_FRONT_PAGE_STORIES : index + 1;

  return (
    <motion.li
      id={`story-${item.id}`}
      initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        shouldReduceMotion
          ? { duration: 0 }
          : { duration: 0.28, delay: (index % PAGE_SIZE) * 0.012 }
      }
      onClick={() => onOpenDetail(detailPath)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetail(detailPath);
        }
      }}
      role="button"
      tabIndex={0}
      className="group content-auto p-4 border cursor-pointer rounded-2xl border-white/15 bg-slate-900/95 transition hover:border-cyan-100/35 hover:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200/60"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="mb-2 flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.16em] text-cyan-100/70">
            <span className="rounded-full border border-cyan-200/30 bg-cyan-300/10 px-2 py-0.5 text-[10px]">
              #{rank}
            </span>
            <span className="truncate">{getDomain(item.url)}</span>
          </p>
          {externalUrl ? (
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="text-lg font-semibold text-white hover:text-cyan-100 hover:underline"
            >
              {title}
            </a>
          ) : (
            <h4 className="text-lg font-semibold text-white">{title}</h4>
          )}
          {snippet ? <p className="mt-2 text-sm text-slate-300/85">{snippet}</p> : null}
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-300/85">
            <span>{(item.score ?? 0).toLocaleString()} points</span>
            <span aria-hidden>•</span>
            <span>
              by{" "}
              <Link
                href={`/?user=${item.by ?? "unknown"}&from=${section}`}
                onClick={(event) => event.stopPropagation()}
                className="hover:text-cyan-100 hover:underline"
              >
                {item.by ?? "unknown"}
              </Link>
            </span>
            <span aria-hidden>•</span>
            <span>{formatRelativeAge(item.time)}</span>
          </p>
        </div>
        <Link
          href={detailPath}
          onClick={(event) => event.stopPropagation()}
          className="shrink-0 rounded-full border border-white/20 bg-white/5 px-3 py-1 text-xs uppercase tracking-[0.14em] text-slate-100 transition group-hover:border-cyan-100/35 group-hover:bg-white/10"
        >
          {isComment ? "view thread" : `${item.descendants ?? 0} comments`}
        </Link>
      </div>
    </motion.li>
  );
});

function FeedView({ section }: { section: Section }) {
  const router = useRouter();
  const shouldReduceMotion = useReducedMotion();
  const reduceMotion = shouldReduceMotion ?? false;
  const [ids, setIds] = useState<number[]>([]);
  const [items, setItems] = useState<HNItem[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [nextFetchIndex, setNextFetchIndex] = useState(MAX_FRONT_PAGE_STORIES);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const loadMoreRef = useRef<AbortController | null>(null);
  const pendingScrollToItemIdRef = useRef<number | null>(null);

  const loadFeed = useCallback(
    async (forceFresh = false) => {
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setErrorMessage("");

      if (section === "submit") {
        setIds([]);
        setItems([]);
        setNextFetchIndex(0);
        setLoadState("ready");
        requestRef.current = null;
        return;
      }

      const cachedSnapshot = !forceFresh
        ? readTimedCache(feedCache, section, FEED_CACHE_TTL_MS)
        : null;
      if (cachedSnapshot) {
        setIds(cachedSnapshot.ids);
        setItems(cachedSnapshot.items);
        setNextFetchIndex(cachedSnapshot.nextFetchIndex);
        setLoadState("ready");
        requestRef.current = null;
        return;
      }

      setLoadState("loading");
      setItems([]);
      setIds([]);

      try {
        const allIds = await fetchStoryIds(section, controller.signal);
        if (controller.signal.aborted) return;

        const startIndex = section === "past" ? MAX_FRONT_PAGE_STORIES : 0;
        const firstPage = await fetchFeedPage(allIds, section, startIndex, controller.signal);
        if (controller.signal.aborted) return;

        setIds(allIds);
        setItems(firstPage.items);
        setNextFetchIndex(firstPage.nextFetchIndex);
        setLoadState("ready");
        writeTimedCache(feedCache, section, {
          ids: allIds,
          items: firstPage.items,
          nextFetchIndex: firstPage.nextFetchIndex,
        });
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        setItems([]);
        setLoadState("error");
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to load Hacker News feed.",
        );
      } finally {
        if (requestRef.current === controller) {
          requestRef.current = null;
        }
      }
    },
    [section],
  );

  useEffect(() => {
    void loadFeed();
    return () => {
      requestRef.current?.abort();
      loadMoreRef.current?.abort();
    };
  }, [loadFeed]);

  useEffect(() => {
    const targetItemId = pendingScrollToItemIdRef.current;
    if (!targetItemId) return;

    const targetElement = document.getElementById(`story-${targetItemId}`);
    if (!targetElement) return;

    pendingScrollToItemIdRef.current = null;
    targetElement.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
  }, [items, reduceMotion]);

  const openDetail = useCallback(
    (detailPath: string) => {
      router.push(detailPath);
    },
    [router],
  );

  const handleRefresh = useCallback(async () => {
    await loadFeed(true);
  }, [loadFeed]);

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || ids.length === 0 || nextFetchIndex >= ids.length) return;
    loadMoreRef.current?.abort();
    const controller = new AbortController();
    loadMoreRef.current = controller;
    setLoadingMore(true);

    try {
      const nextPage = await fetchFeedPage(ids, section, nextFetchIndex, controller.signal);
      if (controller.signal.aborted) return;

      const seen = new Set(items.map((item) => item.id));
      const mergedItems = [...items];
      let firstNewItemId: number | null = null;
      for (const item of nextPage.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (firstNewItemId === null) {
          firstNewItemId = item.id;
        }
        mergedItems.push(item);
      }

      setItems(mergedItems);
      setNextFetchIndex(nextPage.nextFetchIndex);
      pendingScrollToItemIdRef.current = firstNewItemId;
      writeTimedCache(feedCache, section, {
        ids,
        items: mergedItems,
        nextFetchIndex: nextPage.nextFetchIndex,
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("Failed to load more items", error);
      }
    } finally {
      if (loadMoreRef.current === controller) {
        loadMoreRef.current = null;
      }
      setLoadingMore(false);
    }
  }, [ids, items, loadingMore, nextFetchIndex, section]);

  const statusCopy = useMemo(() => {
    if (section === "submit") return "Submit mode";
    if (loadState === "loading") return "Syncing feed...";
    if (loadState === "error") return "Signal lost";
    if (loadingMore) return "Loading more stories...";
    return `${items.length} stories loaded`;
  }, [items.length, loadState, loadingMore, section]);

  const hasMore = ids.length > 0 && nextFetchIndex < ids.length;
  const feedHeading = sectionLabel(section);

  return (
    <section className="grid gap-6">
      <FeedNav activeSection={section} />

      <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-5 border rounded-3xl border-cyan-100/20 bg-slate-950/95">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-cyan-100/70">Realtime Feed</p>
          <h3 className="mt-1 text-2xl font-semibold text-cyan-50">{feedHeading}</h3>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-300/80" aria-live="polite">
            {statusCopy}
          </p>
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={loadState === "loading" || section === "submit"}
            className="rounded-full border border-cyan-100/30 bg-cyan-300/10 px-4 py-2 text-xs uppercase tracking-[0.2em] text-cyan-100 transition hover:bg-cyan-300/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Refresh
          </button>
        </div>
      </div>

      {section === "submit" ? (
        <div className="p-5 border rounded-2xl border-white/20 bg-slate-900/95">
          <h4 className="text-lg font-semibold text-white">Submit to HN Afterglow</h4>
          <p className="mt-2 text-sm text-slate-300">
            This is the local submit page placeholder for your clone. We can wire storage next.
          </p>
        </div>
      ) : null}

      {loadState === "error" ? (
        <div className="p-5 text-sm border rounded-2xl border-rose-200/30 bg-rose-900/20 text-rose-100">
          {errorMessage}
        </div>
      ) : null}

      {loadState === "loading" ? (
        <ol className="space-y-3 overflow-anchor-none" aria-busy="true">
          <FeedRowSkeleton />
          <FeedRowSkeleton />
          <FeedRowSkeleton />
          <FeedRowSkeleton />
          <FeedRowSkeleton />
          <FeedRowSkeleton />
        </ol>
      ) : (
        <ol className="space-y-3 overflow-anchor-none">
          {items.map((item, index) => (
            <StoryListItem
              key={item.id}
              item={item}
              index={index}
              section={section}
              shouldReduceMotion={reduceMotion}
              onOpenDetail={openDetail}
            />
          ))}
        </ol>
      )}

      {loadState === "ready" && items.length === 0 ? (
        <div className="p-5 text-sm border rounded-2xl border-white/15 bg-slate-900/55 text-slate-300">
          No posts available right now.
        </div>
      ) : null}

      {loadState === "ready" && hasMore ? (
        <div className="flex justify-center py-6">
          <button
            type="button"
            onClick={() => void handleLoadMore()}
            disabled={loadingMore}
            className="rounded-full border border-cyan-100/30 bg-cyan-300/10 px-8 py-3 text-sm uppercase tracking-[0.2em] text-cyan-100 transition hover:bg-cyan-300/20 disabled:opacity-50"
          >
            {loadingMore ? "Loading..." : "Load More Stories"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function CommentSkeleton() {
  return (
    <div className="box-border w-full min-w-0 p-4 border animate-pulse rounded-xl border-white/10 bg-slate-900/70">
      <div className="h-3 w-32 rounded-full bg-white/10 mb-3" />
      <div className="space-y-2">
        <div className="h-4 w-full rounded-full bg-white/5" />
        <div className="h-4 w-5/6 rounded-full bg-white/5" />
      </div>
    </div>
  );
}

function CommentTree({
  node,
  depth = 0,
  fromSection,
}: {
  node: HNCommentNode;
  depth?: number;
  fromSection: Section;
}) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const commentText = toPlainText(node.text);
  const indent = Math.min(depth * 10, 28);

  return (
    <div
      className="relative box-border w-full min-w-0 p-4 border rounded-xl border-white/20 bg-slate-900/98"
      style={{ marginLeft: `${indent}px` }}
    >
      {/* Vertical 'tab' for collapsing */}
      <button
        type="button"
        className="absolute left-0 top-0 bottom-0 w-1 cursor-pointer transition-colors hover:bg-cyan-400 group border-none bg-transparent p-0 outline-none"
        onClick={() => setIsCollapsed(!isCollapsed)}
        aria-label={isCollapsed ? "Expand comment tree" : "Collapse comment tree"}
      >
        <div className="absolute inset-y-0 left-0 w-full bg-white/5 group-hover:bg-cyan-400/30" />
      </button>

      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="flex items-center justify-center w-5 h-5 rounded-md bg-white/5 border border-white/10 text-cyan-100/70 hover:bg-white/15 hover:text-cyan-50 transition-colors text-[10px] font-mono"
          >
            {isCollapsed ? "+" : "−"}
          </button>
          <p className="text-xs uppercase tracking-[0.18em] text-cyan-100/85">
            <Link
              href={`/?user=${node.by ?? "unknown"}&from=${fromSection}`}
              className="hover:text-cyan-100 hover:underline"
            >
              {node.by ?? "unknown"}
            </Link>{" "}
            · {formatRelativeAge(node.time)}
          </p>
        </div>
      </div>

      <motion.div
        initial={false}
        animate={{
          height: isCollapsed ? 0 : "auto",
          opacity: isCollapsed ? 0 : 1,
          marginTop: isCollapsed ? 0 : 8,
        }}
        transition={
          shouldReduceMotion ? { duration: 0 } : { duration: 0.25, ease: [0.4, 0, 0.2, 1] }
        }
        className="overflow-hidden"
      >
        <p className="w-full min-w-0 text-base leading-relaxed text-slate-100/95 wrap-break-word whitespace-pre-wrap">
          {commentText}
        </p>

        {node.children.length > 0 ? (
          <div className="min-w-0 mt-3 space-y-3">
            {node.children.map((child) => (
              <CommentTree
                key={child.id}
                node={child}
                depth={depth + 1}
                fromSection={fromSection}
              />
            ))}
          </div>
        ) : null}
      </motion.div>

      {isCollapsed && node.children.length > 0 && (
        <p className="mt-1 text-[10px] uppercase tracking-widest text-cyan-100/40 font-medium">
          {node.children.length} {node.children.length === 1 ? "child" : "children"} hidden
        </p>
      )}
    </div>
  );
}

function PostView({ postId, fromSection }: { postId: number; fromSection: Section }) {
  const cachedPost = readTimedCache(postCache, postId, POST_CACHE_TTL_MS);
  const [item, setItem] = useState<HNItem | null>(cachedPost?.item ?? null);
  const [comments, setComments] = useState<HNCommentNode[]>(cachedPost?.comments ?? []);
  const [loadState, setLoadState] = useState<LoadState>(cachedPost ? "ready" : "loading");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (cachedPost) return;

    const controller = new AbortController();

    void fetchItemById(postId, controller.signal)
      .then(async (nextItem) => {
        if (!nextItem) throw new Error("Post not found.");
        setItem(nextItem);
        const nextComments = await buildCommentTree(nextItem.kids ?? [], controller.signal);
        setComments(nextComments);
        setLoadState("ready");
        writeTimedCache(postCache, postId, {
          item: nextItem,
          comments: nextComments,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setItem(null);
        setComments([]);
        setLoadState("error");
        setErrorMessage(error instanceof Error ? error.message : "Failed to load post details.");
      });

    return () => controller.abort();
  }, [cachedPost, postId]);

  const backPath = sectionPath(fromSection);
  const storyUrl = item?.url;

  return (
    <section className="grid gap-6">
      <FeedNav activeSection={fromSection} />

      <div className="px-6 py-5 border rounded-3xl border-cyan-100/20 bg-slate-950/95">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-2xl font-semibold text-cyan-50">Post</h3>
          <Link
            href={backPath}
            className="rounded-full border border-cyan-100/30 bg-cyan-300/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-cyan-100 hover:bg-cyan-300/20"
          >
            Back to {fromSection}
          </Link>
        </div>
      </div>

      {loadState === "error" ? (
        <div className="p-5 text-sm border rounded-2xl border-rose-200/30 bg-rose-900/20 text-rose-100">
          {errorMessage}
        </div>
      ) : null}

      {item ? (
        <article className="p-6 border rounded-2xl border-white/15 bg-slate-900/95">
          <p className="text-xs uppercase tracking-[0.2em] text-cyan-100/70">
            {item.score ?? 0} points by{" "}
            <Link
              href={`/?user=${item.by ?? "unknown"}&from=${fromSection}`}
              className="hover:text-cyan-100 hover:underline px-1"
            >
              {item.by ?? "unknown"}
            </Link>{" "}
            · {formatRelativeAge(item.time)}
          </p>
          <button
            type="button"
            onClick={scrollToComments}
            className="mt-3 rounded-full border border-cyan-100/30 bg-cyan-300/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-cyan-100 transition hover:bg-cyan-300/20"
          >
            Jump to comments
          </button>
          {storyUrl ? (
            <a
              href={storyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block mt-2 text-3xl font-semibold text-white hover:text-cyan-100 hover:underline"
            >
              {item.title ?? `Thread #${item.id}`}
            </a>
          ) : (
            <h1 className="mt-2 text-3xl font-semibold text-white">
              {item.title ?? `Thread #${item.id}`}
            </h1>
          )}
          {item.text ? (
            <p className="w-full min-w-0 mt-4 text-lg leading-relaxed whitespace-pre-wrap text-slate-200/90 wrap-break-word">
              {toPlainText(item.text)}
            </p>
          ) : null}
        </article>
      ) : loadState === "loading" ? (
        <div className="p-5 text-sm border rounded-2xl border-white/15 bg-slate-900/55 text-slate-200">
          Loading post...
        </div>
      ) : null}

      <section id="comments" className="min-w-0 space-y-3">
        <h2 className="text-xl font-semibold text-white">Comments</h2>
        {loadState === "loading" || loadState === "idle" ? (
          <div className="space-y-3">
            <CommentSkeleton />
            <CommentSkeleton />
            <CommentSkeleton />
          </div>
        ) : comments.length === 0 ? (
          <div className="p-4 text-sm border rounded-2xl border-white/15 bg-slate-900/55 text-slate-300">
            No comments yet.
          </div>
        ) : (
          comments.map((comment) => (
            <CommentTree key={comment.id} node={comment} fromSection={fromSection} />
          ))
        )}
      </section>
    </section>
  );
}

function UserView({ userId, fromSection }: { userId: string; fromSection: Section }) {
  const cacheKey = userId.toLowerCase();
  const cachedUser = readTimedCache(userCache, cacheKey, USER_CACHE_TTL_MS);
  const [user, setUser] = useState<HNUser | null>(cachedUser);
  const [loadState, setLoadState] = useState<LoadState>(cachedUser ? "ready" : "loading");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (cachedUser) return;

    const controller = new AbortController();

    void fetchUserById(userId, controller.signal)
      .then((nextUser) => {
        if (!nextUser) throw new Error("User not found.");
        setUser(nextUser);
        setLoadState("ready");
        writeTimedCache(userCache, cacheKey, nextUser);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setUser(null);
        setLoadState("error");
        setErrorMessage(error instanceof Error ? error.message : "Failed to load user profile.");
      });

    return () => controller.abort();
  }, [cacheKey, cachedUser, userId]);

  const backPath = sectionPath(fromSection);

  return (
    <section className="grid gap-6">
      <FeedNav activeSection={fromSection} />

      <div className="px-6 py-5 border rounded-3xl border-cyan-100/20 bg-slate-950/95">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-2xl font-semibold text-cyan-50">User Profile</h3>
          <Link
            href={backPath}
            className="rounded-full border border-cyan-100/30 bg-cyan-300/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-cyan-100 hover:bg-cyan-300/20"
          >
            Back
          </Link>
        </div>
      </div>

      {loadState === "error" ? (
        <div className="p-5 text-sm border rounded-2xl border-rose-200/30 bg-rose-900/20 text-rose-100">
          {errorMessage}
        </div>
      ) : null}

      {user ? (
        <article className="p-6 border rounded-2xl border-white/15 bg-slate-900/95">
          <p className="text-xs uppercase tracking-[0.2em] text-cyan-100/70">User: {user.id}</p>
          <h1 className="mt-2 text-3xl font-semibold text-white">{user.id}</h1>
          <div className="mt-4 grid grid-cols-2 gap-4 max-w-sm">
            <div className="p-3 border rounded-xl border-white/10 bg-white/5">
              <p className="text-[10px] uppercase tracking-widest text-cyan-100/40">Karma</p>
              <p className="text-xl font-bold text-white">{user.karma.toLocaleString()}</p>
            </div>
            <div className="p-3 border rounded-xl border-white/10 bg-white/5">
              <p className="text-[10px] uppercase tracking-widest text-cyan-100/40">Joined</p>
              <p className="text-xl font-bold text-white">{formatRelativeAge(user.created)}</p>
              <p className="mt-1 text-xs text-slate-300/70">{formatCalendarDate(user.created)}</p>
            </div>
          </div>
          {user.about ? (
            <div className="mt-6">
              <p className="text-[10px] uppercase tracking-widest text-cyan-100/40 mb-2">About</p>
              <div className="w-full min-w-0 text-lg leading-relaxed text-slate-200/90 whitespace-pre-wrap wrap-break-word">
                {toPlainText(user.about)}
              </div>
            </div>
          ) : null}
        </article>
      ) : loadState === "loading" ? (
        <div className="p-5 text-sm border rounded-2xl border-white/15 bg-slate-900/55 text-slate-200">
          Loading user profile...
        </div>
      ) : null}
    </section>
  );
}

export default function HackerNewsFrontPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#020306]" />}>
      <HackerNewsFrontPageInner />
    </Suspense>
  );
}

function HackerNewsFrontPageInner() {
  const searchParams = useSearchParams();
  const section = normalizeSection(searchParams.get("section"));
  const postId = searchParams.get("post");
  const userId = searchParams.get("user");
  const fromSection = normalizeSection(searchParams.get("from"));

  if (userId) {
    return <UserView key={userId} userId={userId} fromSection={fromSection} />;
  }

  if (postId) {
    const numericPostId = Number.parseInt(postId, 10);
    if (Number.isNaN(numericPostId)) {
      return <PostView key={0} postId={0} fromSection={fromSection} />;
    }
    return <PostView key={numericPostId} postId={numericPostId} fromSection={fromSection} />;
  }

  return <FeedView section={section} />;
}
