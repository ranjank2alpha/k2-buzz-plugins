// My claims — K2alpha's Buzz plugin page for the Ledger Accountant (golive79).
//
// Reads the `k2-claims` tag the bot puts on its reply to an unfiltered `!status` in the person's DM
// with it. The DM group has two members, so only the person and the bot can read it. Nothing is sent
// unless the person presses Refresh, which posts `!status` in that DM, as typing it would.
//
// Plain JS for Buzz plugin API v1: one module, React from ctx.react, no imports.

const BOT = "55c9a021f46f667514a448725705c06d8a4fbcd62ab0d4a78ddbfe1877bcfda8";
const TAG = "k2-claims";
const WAIT_MS = 45_000;
const POLL_MS = 2_000;

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const ddmmyyyy = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
};

/** The person's two-member DM with the bot, or undefined. */
export function botDm(channels, viewer) {
  return channels.find(
    (c) =>
      c.channelType === "dm" &&
      Array.isArray(c.members) &&
      c.members.length === 2 &&
      c.members.includes(BOT) &&
      c.members.includes(viewer),
  );
}

/** The newest valid snapshot among the bot's events, or null. */
export function latestSnapshot(events) {
  let best = null;
  for (const event of events) {
    if (event.pubkey !== BOT || event.kind !== 9) continue;
    const tag = event.tags.find((t) => t[0] === TAG && typeof t[1] === "string");
    if (!tag) continue;
    let data;
    try {
      data = JSON.parse(tag[1]);
    } catch {
      continue;
    }
    if (!data || data.v !== 1 || !Array.isArray(data.rows)) continue;
    if (best && best.createdAt >= event.created_at) continue;
    best = {
      createdAt: event.created_at,
      at: typeof data.at === "string" ? data.at : null,
      truncated: data.truncated === true,
      rows: data.rows.filter((r) => r && typeof r.claim === "string"),
    };
  }
  return best;
}

export function totals(rows) {
  let pending = 0;
  let paid = 0;
  let open = 0;
  for (const r of rows) {
    if (r.paidOn) paid += Number(r.paidAmount) || 0;
    else {
      pending += Number(r.share) || 0;
      open += 1;
    }
  }
  return { pending, paid, open };
}

export const inject = ["react", "pages", "relay"];

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;

  async function readSnapshot(session, channelId, signal) {
    const events = await session.read(
      [{ kinds: [9], "#h": [channelId], authors: [BOT], limit: 200 }],
      { signal },
    );
    return latestSnapshot(events);
  }

  function useConnection() {
    return React.useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
  }

  function useDm(session, viewer) {
    const channels = session && session.channels;
    const read = () => (channels ? botDm(channels.list().channels, viewer) : undefined);
    const [dm, setDm] = React.useState(read);
    React.useEffect(() => {
      if (!channels) return undefined;
      setDm(read());
      return channels.subscribeList(() => setDm(read()));
    }, [channels, viewer]);
    return dm;
  }

  const cell = { padding: "var(--space-2) var(--space-3)", textAlign: "left", whiteSpace: "nowrap" };
  const head = { ...cell, color: "var(--text-subtle)", fontWeight: 600, borderBottom: "1px solid var(--border-standard)" };
  const row = { borderBottom: "1px solid var(--border-standard)" };
  const subtle = { color: "var(--text-subtle)" };

  function status(r) {
    if (!r.paidOn) return "Pending";
    const wo = Number(r.writeOff) || 0;
    return wo > 0.5
      ? `Paid ${ddmmyyyy(r.paidOn)}: ${inr.format(Number(r.paidAmount) || 0)} paid, ${inr.format(wo)} written off`
      : `Paid ${ddmmyyyy(r.paidOn)}`;
  }

  function Table({ rows }) {
    return h(
      "div",
      { style: { overflowX: "auto", width: "100%" } },
      h(
        "table",
        { style: { borderCollapse: "collapse", width: "100%" } },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            ["Claim", "Client", "Filed", "Your share", "Status", "UTR"].map((label) =>
              h("th", { key: label, style: label === "Your share" ? { ...head, textAlign: "right" } : head }, label),
            ),
          ),
        ),
        h(
          "tbody",
          null,
          rows.map((r) =>
            h(
              "tr",
              { key: r.claim, style: row },
              h("td", { style: { ...cell, fontFamily: "var(--font-mono, monospace)" } }, r.claim),
              h("td", { style: cell }, r.client || "—"),
              h("td", { style: cell }, ddmmyyyy(r.filed)),
              h("td", { style: { ...cell, textAlign: "right" } }, inr.format(Number(r.share) || 0)),
              h("td", { style: r.paidOn ? cell : { ...cell, fontWeight: 600 } }, status(r)),
              h("td", { style: { ...cell, ...subtle } }, r.utr || (r.paidOn ? "none recorded" : "—")),
            ),
          ),
        ),
      ),
    );
  }

  function MyClaims() {
    const connection = useConnection();
    const ready = connection.status === "ready" && connection.viewer;
    const session = ready ? connection.session : undefined;
    const dm = useDm(session, connection.viewer);
    const [snapshot, setSnapshot] = React.useState(undefined); // undefined = loading, null = none yet
    const [error, setError] = React.useState(null);
    const [refreshing, setRefreshing] = React.useState(false);
    const [filter, setFilter] = React.useState("all");

    React.useEffect(() => {
      if (!session || !dm) return undefined;
      const controller = new AbortController();
      setSnapshot(undefined);
      readSnapshot(session, dm.id, controller.signal).then(
        (found) => !controller.signal.aborted && setSnapshot(found),
        (cause) => !controller.signal.aborted && setError(String(cause && cause.message ? cause.message : cause)),
      );
      return () => controller.abort();
    }, [session, dm && dm.id]);

    async function refresh() {
      if (!session || !dm || refreshing) return;
      setRefreshing(true);
      setError(null);
      const since = Math.floor(Date.now() / 1000) - 5;
      try {
        await session.messages.send(dm.id, "!status");
        const until = Date.now() + WAIT_MS;
        while (Date.now() < until) {
          await new Promise((done) => setTimeout(done, POLL_MS));
          const found = await readSnapshot(session, dm.id);
          if (found && found.createdAt >= since) {
            setSnapshot(found);
            return;
          }
        }
        setError("The Ledger Accountant did not answer in time. Try again in a minute.");
      } catch (cause) {
        setError(String(cause && cause.message ? cause.message : cause));
      } finally {
        setRefreshing(false);
      }
    }

    const body = [];
    if (!ready) body.push(h("p", { key: "c", style: subtle }, "Connecting…"));
    else if (!dm)
      body.push(
        h("p", { key: "n" }, "You have no DM with the Ledger Accountant yet. Send it a message once, then come back here."),
      );
    else if (snapshot === undefined && !error) body.push(h("p", { key: "l", style: subtle }, "Loading your claims…"));
    else if (snapshot === null)
      body.push(h("p", { key: "e" }, "Your claims haven't been loaded here yet. Press Refresh to fetch them."));
    else if (snapshot) {
      const t = totals(snapshot.rows);
      const shown = snapshot.rows.filter((r) => (filter === "all" ? true : filter === "pending" ? !r.paidOn : !!r.paidOn));
      body.push(
        h(
          "p",
          { key: "s" },
          snapshot.rows.length
            ? `${inr.format(t.pending)} pending across ${t.open} ${t.open === 1 ? "claim" : "claims"} · ${inr.format(t.paid)} paid back`
            : "You have no claims on record yet.",
        ),
      );
      if (snapshot.rows.length) {
        body.push(
          h(
            "div",
            { key: "f", style: { display: "flex", gap: "var(--space-2)", flexWrap: "wrap" } },
            [
              ["all", "All"],
              ["pending", "Pending"],
              ["paid", "Paid"],
            ].map(([value, label]) =>
              h(
                "button",
                { key: value, type: "button", "aria-pressed": filter === value, onClick: () => setFilter(value), style: filter === value ? { fontWeight: 600 } : undefined },
                label,
              ),
            ),
          ),
        );
        body.push(h(Table, { key: "t", rows: shown }));
        if (snapshot.truncated)
          body.push(h("p", { key: "tr", style: subtle }, "Showing your most recent claims only."));
      }
      body.push(
        h(
          "p",
          { key: "a", style: subtle },
          `As of ${snapshot.at ? new Date(snapshot.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "the last check"}. Your share on each claim only.`,
        ),
      );
    }
    if (error) body.push(h("p", { key: "x", role: "alert", style: { color: "var(--text-danger)" } }, error));

    return h(
      "section",
      { style: { padding: "var(--space-panel-inset)", display: "flex", flexDirection: "column", gap: "var(--space-3)", width: "100%", boxSizing: "border-box" } },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", flexWrap: "wrap" } },
        h("h1", { style: { margin: 0 } }, "My claims"),
        dm
          ? h("button", { type: "button", onClick: refresh, disabled: refreshing }, refreshing ? "Refreshing…" : "Refresh")
          : null,
      ),
      ...body,
    );
  }

  ctx.pages.register({ id: "main", title: "My claims", primary: true, component: MyClaims });
}
