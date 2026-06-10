<script lang="ts">
  import { tick } from "svelte";
  import { galleryItems, galleryManifest, galleryStats, tierCounts, type GalleryItem, type ImageVariant } from "../.generated/gallery-manifest";

  const baseUrl = import.meta.env.BASE_URL;
  const sortLabels: Record<string, string> = {
    "tier-desc": "tier high to low",
    "tier-asc": "tier low to high",
    "title-asc": "title A-Z",
    "title-desc": "title Z-A"
  };
  const tierLabels: Record<number, string> = {
    1: "Single static artifact",
    2: "Static composition",
    3: "Motion or interaction",
    4: "Stateful control",
    5: "Multi-feature widget",
    6: "Cohesive mini-app",
    7: "Real logic/mechanics",
    8: "Apex cohesion + logic",
    9: "Substantial complete experience",
    10: "Wow/max multi-system build",
    11: "Library-powered iterated ceiling"
  };

  let query = "";
  let sortValue = "tier-desc";
  let activeTier: "all" | number = "all";
  let visibleLimit = galleryManifest.chunkSize;
  let previousFilterKey = "";
  let selectedItem: GalleryItem | null = null;
  let detailDialog: HTMLDialogElement;

  const itemTiers = [...new Set(galleryItems.map((item) => item.tier))].sort((a, b) => a - b);
  const maxTierCount = Math.max(...Object.values(tierCounts), 1);

  $: filterKey = `${query.trim().toLowerCase()}|${sortValue}|${activeTier}`;
  $: if (filterKey !== previousFilterKey) {
    previousFilterKey = filterKey;
    visibleLimit = galleryManifest.chunkSize;
  }
  $: filteredItems = getFilteredItems(query, activeTier, sortValue);
  $: visibleItems = filteredItems.slice(0, visibleLimit);
  $: hasMore = visibleItems.length < filteredItems.length;
  $: tierLabel = activeTier === "all" ? "all tiers" : tierName(activeTier);
  $: filterStatus = `Showing ${filteredItems.length} of ${galleryStats.total} artifacts / ${tierLabel} / sorted by ${sortLabels[sortValue]}${query.trim() ? ` / search: "${query.trim()}"` : ""}`;
  $: hasActiveControls = activeTier !== "all" || query.trim() !== "" || sortValue !== "tier-desc";

  function getFilteredItems(searchQuery: string, tier: "all" | number, sort: string) {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return galleryItems
      .filter((item) => tier === "all" || item.tier === tier)
      .filter((item) => !normalizedQuery || item.searchText.includes(normalizedQuery))
      .slice()
      .sort((a, b) => {
        if (sort === "tier-asc") return a.tier - b.tier || a.title.localeCompare(b.title);
        if (sort === "title-asc") return a.title.localeCompare(b.title);
        if (sort === "title-desc") return b.title.localeCompare(a.title);
        return b.tier - a.tier || a.title.localeCompare(b.title);
      });
  }

  function tierName(tier: number) {
    return `T${tier}`;
  }

  function assetUrl(filePath: string) {
    return `${baseUrl}${filePath}`;
  }

  function itemHref(item: GalleryItem) {
    return assetUrl(item.path);
  }

  function srcset(variants: ImageVariant[]) {
    return variants.map((variant) => `${assetUrl(variant.path)} ${variant.width}w`).join(", ");
  }

  function resetGallery() {
    activeTier = "all";
    query = "";
    sortValue = "tier-desc";
    visibleLimit = galleryManifest.chunkSize;
  }

  function showMore() {
    if (hasMore) {
      visibleLimit = Math.min(visibleLimit + galleryManifest.chunkSize, filteredItems.length);
    }
  }

  async function openDetails(item: GalleryItem) {
    selectedItem = item;
    await tick();
    if (typeof detailDialog.showModal === "function") {
      detailDialog.showModal();
    } else {
      detailDialog.setAttribute("open", "");
    }
  }

  function closeDetails() {
    detailDialog.close();
  }

  function handleDialogClick(event: MouseEvent) {
    if (event.target === detailDialog) closeDetails();
  }

  function loadMoreSentinel(node: HTMLElement) {
    if (!("IntersectionObserver" in window)) return {};
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) showMore();
    }, { rootMargin: "640px 0px" });
    observer.observe(node);
    return {
      destroy() {
        observer.disconnect();
      }
    };
  }
</script>

<svelte:head>
  {#if visibleItems[0]}
    <link rel="preload" as="image" type="image/avif" href={assetUrl(visibleItems[0].image.thumbnails.avif[0].path)} imagesrcset={srcset(visibleItems[0].image.thumbnails.avif)} imagesizes={galleryManifest.cardSizes} fetchpriority="high" />
  {/if}
</svelte:head>

<header class="site-header">
  <div class="shell">
    <div class="masthead">
      <div>
        <p class="eyebrow">Jules realization probe archive</p>
        <h1>Jules Toys Gallery</h1>
        <p class="lede">A public, static showcase of rendered HTML experiments, organized by the ambition ladder and kept close to the evidence: screenshots, paths, provenance, and factual behavior summaries.</p>
      </div>
      <dl class="stats" aria-label="Gallery stats">
        <div class="stat">
          <dt class="meta-label">Artifacts</dt>
          <dd><strong>{galleryStats.total}</strong><span>committed toys</span></dd>
        </div>
        <div class="stat">
          <dt class="meta-label">Ladder</dt>
          <dd><strong>T{galleryStats.tierMin}-T{galleryStats.tierMax}</strong><span>ambition tiers</span></dd>
        </div>
        <div class="stat">
          <dt class="meta-label">Thumbs</dt>
          <dd><strong>{Math.round(galleryStats.thumbWebpBytes / 1024)} KB</strong><span>480w WebP set</span></dd>
        </div>
      </dl>
    </div>

    <search class="controls">
      <div class="field">
        <label for="searchInput">Search gallery</label>
        <input id="searchInput" bind:value={query} type="search" autocomplete="off" placeholder="terrain, dispatch, sequencer, T8" />
      </div>
      <div class="field">
        <label for="sortSelect">Sort</label>
        <select id="sortSelect" bind:value={sortValue}>
          <option value="tier-desc">Tier high to low</option>
          <option value="tier-asc">Tier low to high</option>
          <option value="title-asc">Title A-Z</option>
          <option value="title-desc">Title Z-A</option>
        </select>
      </div>
      <button class="ghost-button" type="button" id="resetFilters" disabled={!hasActiveControls} onclick={resetGallery}>Reset</button>
      <div class="tier-filter" role="group" aria-label="Tier filter" id="tierFilter">
        <button class="tier-button" type="button" aria-pressed={activeTier === "all"} onclick={() => activeTier = "all"}>All</button>
        {#each itemTiers as tier}
          <button class="tier-button" type="button" aria-pressed={activeTier === tier} onclick={() => activeTier = tier}>{tierName(tier)}</button>
        {/each}
      </div>
    </search>

    <div class="filter-status" id="filterStatus" aria-live="polite">{filterStatus}</div>
  </div>
</header>

<main class="shell">
  <section aria-labelledby="galleryTitle">
    <div class="section-heading">
      <div>
        <p class="section-kicker">Archive</p>
        <h2 id="galleryTitle">Experiment index</h2>
      </div>
      <p id="resultCount">Showing {filteredItems.length} of {galleryStats.total}</p>
    </div>

    <div class="gallery" id="galleryGrid">
      {#if visibleItems.length}
        {#each visibleItems as item, index (item.tier + ":" + item.slug)}
          <article class:deferred-card={index >= 8} class="toy-card">
            <div class="toy-shot">
              <picture>
                <source type="image/avif" srcset={srcset(item.image.thumbnails.avif)} sizes={galleryManifest.cardSizes} />
                <source type="image/webp" srcset={srcset(item.image.thumbnails.webp)} sizes={galleryManifest.cardSizes} />
                <img
                  src={assetUrl(item.image.thumbnails.webp[0].path)}
                  alt={`Screenshot of ${item.title}`}
                  width={item.image.width}
                  height={item.image.height}
                  loading={index < 4 ? "eager" : "lazy"}
                  decoding={index === 0 ? "sync" : "async"}
                  fetchpriority={index === 0 ? "high" : undefined}
                />
              </picture>
            </div>
            <div class="toy-body">
              <div class="card-topline">
                <span class="tier-pill">{tierName(item.tier)}</span>
                <span class="kind">{item.kind}</span>
              </div>
              <h3>{item.title}</h3>
              <p>{item.oneLine}</p>
              <ul class="tags" aria-label={`Tags for ${item.title}`}>
                {#each item.tags as tag}
                  <li class="tag">{tag}</li>
                {/each}
              </ul>
              <div class="card-actions">
                <a class="open-link" href={itemHref(item)}>Open toy</a>
                <button class="detail-button" type="button" onclick={() => openDetails(item)}>Details</button>
              </div>
            </div>
          </article>
        {/each}
      {:else}
        <div class="empty-state">
          <p>No matching artifacts.</p>
          <button class="ghost-button" type="button" disabled={!hasActiveControls} onclick={resetGallery}>Reset filters</button>
        </div>
      {/if}
    </div>

    {#if hasMore}
      <div class="load-more" use:loadMoreSentinel>
        <button class="ghost-button" type="button" onclick={showMore}>Show more</button>
        <span>{visibleItems.length} of {filteredItems.length} mounted</span>
      </div>
    {/if}
  </section>

  <section class="overview-panel" aria-labelledby="ladderTitle">
    <div>
      <p class="section-kicker">Tier ladder</p>
      <h2 id="ladderTitle">Evidence distribution</h2>
    </div>
    <div class="ladder" id="tierLadder">
      {#each [...itemTiers].reverse() as tier}
        <button
          type="button"
          class="ladder-row"
          style={`--count: ${tierCounts[tier] || 0}; --max-count: ${maxTierCount};`}
          aria-pressed={activeTier === tier}
          onclick={() => activeTier = tier}
        >
          <strong>{tierName(tier)}</strong>
          <em>{tierCounts[tier] || 0}</em>
          <span>{tierLabels[tier] || "Ambition tier"}</span>
          <span class="bar" aria-hidden="true"></span>
        </button>
      {/each}
    </div>
  </section>
</main>

<dialog bind:this={detailDialog} onclick={handleDialogClick} aria-labelledby="dialogTitle">
  {#if selectedItem}
    <div class="dialog-shell">
      <div class="dialog-media">
        <picture>
          <source type="image/avif" srcset={srcset(selectedItem.image.preview.avif)} sizes="(max-width: 760px) calc(100vw - 32px), 640px" />
          <source type="image/webp" srcset={srcset(selectedItem.image.preview.webp)} sizes="(max-width: 760px) calc(100vw - 32px), 640px" />
          <img src={assetUrl(selectedItem.image.preview.webp[0].path)} alt={`Screenshot of ${selectedItem.title}`} width={selectedItem.image.width} height={selectedItem.image.height} decoding="async" />
        </picture>
      </div>
      <div class="dialog-copy">
        <button class="dialog-close" type="button" aria-label="Close details" onclick={closeDetails}>X</button>
        <div>
          <p class="card-kicker">{tierName(selectedItem.tier)} / {selectedItem.kind}</p>
          <h2 id="dialogTitle">{selectedItem.title}</h2>
        </div>
        <p>{selectedItem.oneLine}</p>
        <dl class="meta-list">
          <dt>Path</dt>
          <dd>{selectedItem.path}</dd>
          <dt>Kind</dt>
          <dd>{selectedItem.kind}</dd>
          <dt>Tags</dt>
          <dd>{selectedItem.tags.join(", ")}</dd>
        </dl>
        <div class="dialog-actions">
          <a class="primary-link" href={itemHref(selectedItem)}>Open toy</a>
        </div>
      </div>
    </div>
  {/if}
</dialog>

<footer class="site-footer">
  <div class="shell">Static GitHub Pages gallery for Drew-Goddyn/jules-toys.</div>
</footer>
