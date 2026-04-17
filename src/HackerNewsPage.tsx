import { motion, useReducedMotion } from "framer-motion";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useCallback, useEffect, memo, useMemo, useRef, useState } from "react";

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

const VALID_SECTIONS = new Set<string>(TAB_LINKS.map((t) => t.id));

const textCache = new Map<string, string>();
const feedCache = new Map<Section, TimedValue<FeedSnapshot>>();
const userCache = new Map<string, TimedValue<HNUser>>();
const postCache = new Map<number, TimedValue<PostSnapshot>>();

function sectionPath(section: Section): string {
  return section === "top" ? "/" : `/?section=${section}`;
}

function normalizeSection(value: string | null | undefined): Section {
  return value != null && VALID_SECTIONS.has(value) ? (value as Section) : "top";
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

  const doc = new DOMParser().parseFromString(value, "text/html");
  const normalized = ((doc.body as HTMLElement).innerText || doc.body.textContent || "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

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
    <nav className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-surface p-2">
      <Link
        to="/"
        className="rounded-md px-3 py-1.5 text-sm font-medium text-muted transition hover:bg-surface-2 hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        home
      </Link>
      {TAB_LINKS.map((item) => {
        const isActive = activeSection === item.id;
        return (
          <Link
            key={item.id}
            to={sectionPath(item.id)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              isActive
                ? "bg-accent text-accent-fg"
                : "text-muted hover:bg-surface-2 hover:text-text"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
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
    <li className="rounded-lg border border-border bg-surface p-4 animate-pulse">
      <div className="h-3 w-24 rounded bg-surface-2" />
      <div className="mt-3 h-5 w-5/6 rounded bg-surface-2" />
      <div className="mt-3 h-4 w-full rounded bg-surface-2" />
      <div className="mt-2 h-4 w-2/3 rounded bg-surface-2" />
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
      className="group cursor-pointer content-auto rounded-lg border border-border bg-surface p-4 transition hover:border-border-strong hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-subtle">
            <span className="tabular-nums">{rank}.</span>
            <span className="truncate">{getDomain(item.url)}</span>
          </p>
          {externalUrl ? (
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="text-base font-medium text-text hover:text-accent hover:underline"
            >
              {title}
            </a>
          ) : (
            <h4 className="text-base font-medium text-text">{title}</h4>
          )}
          {snippet ? <p className="mt-2 text-sm text-muted">{snippet}</p> : null}
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
            <span className="font-medium text-muted">
              {(item.score ?? 0).toLocaleString()} points
            </span>
            <span aria-hidden>·</span>
            <span>
              by{" "}
              <Link
                to={`/?user=${item.by ?? "unknown"}&from=${section}`}
                onClick={(event) => event.stopPropagation()}
                className="text-muted hover:text-accent hover:underline"
              >
                {item.by ?? "unknown"}
              </Link>
            </span>
            <span aria-hidden>·</span>
            <span>{formatRelativeAge(item.time)}</span>
          </p>
        </div>
        <Link
          to={detailPath}
          onClick={(event) => event.stopPropagation()}
          className="shrink-0 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted transition group-hover:border-border-strong group-hover:text-text"
        >
          {isComment ? "view thread" : `${item.descendants ?? 0} comments`}
        </Link>
      </div>
    </motion.li>
  );
});

function FeedView({ section }: { section: Section }) {
  const navigate = useNavigate();
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
    <section className="grid gap-4">
      <FeedNav activeSection={section} />

      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <h3 className="text-lg font-semibold text-text">{feedHeading}</h3>
          <p className="mt-0.5 text-xs text-subtle" aria-live="polite">
            {statusCopy}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={loadState === "loading" || section === "submit"}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-muted transition hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          Refresh
        </button>
      </div>

      {section === "submit" ? (
        <div className="rounded-lg border border-border bg-surface p-5">
          <h4 className="text-base font-semibold text-text">Submit to HN Afterglow</h4>
          <p className="mt-2 text-sm text-muted">
            This is the local submit page placeholder for your clone. We can wire storage next.
          </p>
        </div>
      ) : null}

      {loadState === "error" ? (
        <div className="rounded-lg border border-danger bg-danger-bg p-4 text-sm text-danger">
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
              onOpenDetail={navigate}
            />
          ))}
        </ol>
      )}

      {loadState === "ready" && items.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-5 text-sm text-muted">
          No posts available right now.
        </div>
      ) : null}

      {loadState === "ready" && hasMore ? (
        <div className="flex justify-center py-4">
          <button
            type="button"
            onClick={() => void handleLoadMore()}
            disabled={loadingMore}
            className="rounded-md border border-border bg-surface px-5 py-2 text-sm font-medium text-muted transition hover:border-border-strong hover:text-text disabled:opacity-50"
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function CommentSkeleton() {
  return (
    <div className="box-border w-full min-w-0 animate-pulse rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 h-3 w-32 rounded bg-surface-2" />
      <div className="space-y-2">
        <div className="h-4 w-full rounded bg-surface-2" />
        <div className="h-4 w-5/6 rounded bg-surface-2" />
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
      className="relative box-border w-full min-w-0 rounded-lg border border-border bg-surface p-4"
      style={{ marginLeft: `${indent}px` }}
    >
      <button
        type="button"
        className="group absolute left-0 top-0 bottom-0 w-1 cursor-pointer border-none bg-transparent p-0 outline-none transition-colors"
        onClick={() => setIsCollapsed(!isCollapsed)}
        aria-label={isCollapsed ? "Expand comment tree" : "Collapse comment tree"}
      >
        <div className="absolute inset-y-0 left-0 w-full bg-border group-hover:bg-accent" />
      </button>

      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="flex h-5 w-5 items-center justify-center rounded border border-border bg-surface-2 text-[10px] font-mono text-muted transition-colors hover:border-border-strong hover:text-text"
          >
            {isCollapsed ? "+" : "−"}
          </button>
          <p className="text-xs text-subtle">
            <Link
              to={`/?user=${node.by ?? "unknown"}&from=${fromSection}`}
              className="font-medium text-muted hover:text-accent hover:underline"
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
        <p className="w-full min-w-0 whitespace-pre-wrap text-sm leading-relaxed text-text wrap-break-word">
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
        <p className="mt-1 text-[11px] font-medium text-subtle">
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
    <section className="grid gap-4">
      <FeedNav activeSection={fromSection} />

      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <h3 className="text-lg font-semibold text-text">Post</h3>
        <Link
          to={backPath}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-muted transition hover:border-border-strong hover:text-text"
        >
          ← Back to {fromSection}
        </Link>
      </div>

      {loadState === "error" ? (
        <div className="rounded-lg border border-danger bg-danger-bg p-4 text-sm text-danger">
          {errorMessage}
        </div>
      ) : null}

      {item ? (
        <article className="rounded-lg border border-border bg-surface p-6">
          {storyUrl ? (
            <a
              href={storyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-2xl font-semibold text-text hover:text-accent hover:underline"
            >
              {item.title ?? `Thread #${item.id}`}
            </a>
          ) : (
            <h1 className="text-2xl font-semibold text-text">
              {item.title ?? `Thread #${item.id}`}
            </h1>
          )}
          <p className="mt-2 text-sm text-subtle">
            <span className="font-medium text-muted">
              {(item.score ?? 0).toLocaleString()} points
            </span>{" "}
            by{" "}
            <Link
              to={`/?user=${item.by ?? "unknown"}&from=${fromSection}`}
              className="text-muted hover:text-accent hover:underline"
            >
              {item.by ?? "unknown"}
            </Link>{" "}
            · {formatRelativeAge(item.time)}
          </p>
          <button
            type="button"
            onClick={scrollToComments}
            className="mt-3 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm font-medium text-muted transition hover:border-border-strong hover:text-text"
          >
            Jump to comments
          </button>
          {item.text ? (
            <p className="mt-4 w-full min-w-0 whitespace-pre-wrap text-base leading-relaxed text-text wrap-break-word">
              {toPlainText(item.text)}
            </p>
          ) : null}
        </article>
      ) : loadState === "loading" ? (
        <div className="rounded-lg border border-border bg-surface p-5 text-sm text-muted">
          Loading post...
        </div>
      ) : null}

      <section id="comments" className="min-w-0 space-y-3">
        <h2 className="text-base font-semibold text-text">Comments</h2>
        {loadState === "loading" || loadState === "idle" ? (
          <div className="space-y-3">
            <CommentSkeleton />
            <CommentSkeleton />
            <CommentSkeleton />
          </div>
        ) : comments.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-4 text-sm text-muted">
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
    <section className="grid gap-4">
      <FeedNav activeSection={fromSection} />

      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <h3 className="text-lg font-semibold text-text">User profile</h3>
        <Link
          to={backPath}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-muted transition hover:border-border-strong hover:text-text"
        >
          ← Back
        </Link>
      </div>

      {loadState === "error" ? (
        <div className="rounded-lg border border-danger bg-danger-bg p-4 text-sm text-danger">
          {errorMessage}
        </div>
      ) : null}

      {user ? (
        <article className="rounded-lg border border-border bg-surface p-6">
          <h1 className="text-2xl font-semibold text-text">{user.id}</h1>
          <div className="mt-4 grid max-w-sm grid-cols-2 gap-3">
            <div className="rounded-md border border-border bg-surface-2 p-3">
              <p className="text-xs text-subtle">Karma</p>
              <p className="text-lg font-semibold text-text">{user.karma.toLocaleString()}</p>
            </div>
            <div className="rounded-md border border-border bg-surface-2 p-3">
              <p className="text-xs text-subtle">Joined</p>
              <p className="text-lg font-semibold text-text">{formatRelativeAge(user.created)}</p>
              <p className="mt-1 text-xs text-muted">{formatCalendarDate(user.created)}</p>
            </div>
          </div>
          {user.about ? (
            <div className="mt-6">
              <p className="mb-2 text-xs text-subtle">About</p>
              <div className="w-full min-w-0 whitespace-pre-wrap text-sm leading-relaxed text-text wrap-break-word">
                {toPlainText(user.about)}
              </div>
            </div>
          ) : null}
        </article>
      ) : loadState === "loading" ? (
        <div className="rounded-lg border border-border bg-surface p-5 text-sm text-muted">
          Loading user profile...
        </div>
      ) : null}
    </section>
  );
}

export default function HackerNewsFrontPage() {
  const [searchParams] = useSearchParams();
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
