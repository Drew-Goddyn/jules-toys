<script lang="ts">
  import { tick } from "svelte";
  import useEmblaCarousel from "embla-carousel-svelte";
  import PhotoSwipeLightbox from "photoswipe/lightbox";
  import "photoswipe/style.css";
  import { galleryItems, galleryManifest, galleryStats, tierCounts, type GalleryItem, type ImageVariant } from "../.generated/gallery-manifest";

  type EmblaApi = {
    canScrollNext: () => boolean;
    canScrollPrev: () => boolean;
    off: (event: string, callback: (api: EmblaApi) => void) => EmblaApi;
    on: (event: string, callback: (api: EmblaApi) => void) => EmblaApi;
    reInit: () => void;
    scrollNext: () => void;
    scrollPrev: () => void;
  };

  const baseUrl = import.meta.env.BASE_URL;
  const featuredLimit = 12;
  const emblaOptions = { align: "start", containScroll: "trimSnaps" };
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
  let previousFeaturedKey = "";
  let featuredEmbla: EmblaApi | null = null;
  let canScrollFeaturedNext = false;
  let canScrollFeaturedPrev = false;

  const itemTiers = [...new Set(galleryItems.map((item) => item.tier))].sort((a, b) => a - b);
  const maxTierCount = Math.max(...Object.values(tierCounts), 1);

  $: filterKey = `${query.trim().toLowerCase()}|${sortValue}|${activeTier}`;
  $: if (filterKey !== previousFilterKey) {
    previousFilterKey = filterKey;
    visibleLimit = galleryManifest.chunkSize;
  }
  $: filteredItems = getFilteredItems(query, activeTier, sortValue);
  $: visibleItems = filteredItems.slice(0, visibleLimit);
  $: featuredItems = filteredItems.slice(0, featuredLimit);
  $: hasMore = visibleItems.length < filteredItems.length;
  $: tierLabel = activeTier === "all" ? "all tiers" : tierName(activeTier);
  $: featuredKicker = activeTier === "all" && !query.trim() ? "Highest-tier set" : "Current set";
  $: filterStatus = `Showing ${filteredItems.length} of ${galleryStats.total} artifacts / ${tierLabel} / sorted by ${sortLabels[sortValue]}${query.trim() ? ` / search: "${query.trim()}"` : ""}`;
  $: hasActiveControls = activeTier !== "all" || query.trim() !== "" || sortValue !== "tier-desc";
  $: featuredKey = featuredItems.map((item) => `${item.tier}:${item.slug}`).join("|");
  $: if (featuredKey !== previousFeaturedKey) {
    previousFeaturedKey = featuredKey;
    tick().then(() => {
      featuredEmbla?.reInit();
      updateFeaturedControls();
    });
  }

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

  function previewImage(item: GalleryItem) {
    return item.image.preview.webp[0];
  }

  function previewHref(item: GalleryItem) {
    return assetUrl(previewImage(item).path);
  }

  function previewSrcset(item: GalleryItem) {
    return srcset(item.image.preview.webp);
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

  function handleFeaturedInit(event: CustomEvent<EmblaApi>) {
    featuredEmbla?.off("select", updateFeaturedControls);
    featuredEmbla?.off("reInit", updateFeaturedControls);
    featuredEmbla = event.detail;
    featuredEmbla.on("select", updateFeaturedControls);
    featuredEmbla.on("reInit", updateFeaturedControls);
    updateFeaturedControls();
  }

  function updateFeaturedControls() {
    canScrollFeaturedPrev = featuredEmbla?.canScrollPrev() ?? false;
    canScrollFeaturedNext = featuredEmbla?.canScrollNext() ?? false;
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

  function photoSwipeGallery(node: HTMLElement) {
    const lightbox = new PhotoSwipeLightbox({
      gallery: node,
      children: ".preview-frame",
      pswpModule: () => import("photoswipe"),
      bgOpacity: 0.92
    });
    lightbox.on("uiRegister", () => {
      lightbox.pswp.ui.registerElement({
        name: "custom-caption",
        order: 9,
        isButton: false,
        appendTo: "root",
        html: "",
        onInit: (element, pswp) => {
          pswp.on("change", () => {
            const caption = pswp.currSlide?.data.element?.querySelector<HTMLElement>(".hidden-caption-content");
            element.innerHTML = caption?.innerHTML || "";
          });
        }
      });
    });
    lightbox.init();

    return {
      destroy() {
        lightbox.destroy();
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
        <button class="tier-button" type="button" data-tier="all" aria-pressed={activeTier === "all"} onclick={() => activeTier = "all"}>All</button>
        {#each itemTiers as tier}
          <button class="tier-button" type="button" data-tier={tier} aria-pressed={activeTier === tier} onclick={() => activeTier = tier}>{tierName(tier)}</button>
        {/each}
      </div>
    </search>

    <div class="filter-status" id="filterStatus" aria-live="polite">{filterStatus}</div>
  </div>
</header>

<main class="shell">
  {#if featuredItems.length}
    <section class="featured-panel" aria-labelledby="featuredTitle" use:photoSwipeGallery>
      <div class="featured-heading">
        <div>
          <p class="section-kicker">{featuredKicker}</p>
          <h2 id="featuredTitle">Featured previews</h2>
        </div>
        <div class="featured-controls">
          <button class="rail-button" type="button" aria-label="Previous featured preview" disabled={!canScrollFeaturedPrev} onclick={() => featuredEmbla?.scrollPrev()}>Prev</button>
          <button class="rail-button" type="button" aria-label="Next featured preview" disabled={!canScrollFeaturedNext} onclick={() => featuredEmbla?.scrollNext()}>Next</button>
        </div>
      </div>

      <div class="embla">
        <div class="embla__viewport" use:useEmblaCarousel={{ options: emblaOptions, plugins: [] }} onemblaInit={handleFeaturedInit}>
          <div class="embla__container">
            {#each featuredItems as item, index (item.tier + ":" + item.slug)}
              <article class="embla__slide">
                <figure class="featured-card preview-frame">
                  <a
                    class="featured-shot"
                    href={previewHref(item)}
                    data-pswp-src={previewHref(item)}
                    data-pswp-srcset={previewSrcset(item)}
                    data-pswp-width={previewImage(item).width}
                    data-pswp-height={previewImage(item).height}
                    target="_blank"
                    rel="noopener"
                    aria-label={`Preview screenshot of ${item.title}`}
                  >
                    <picture>
                      <source type="image/avif" srcset={srcset(item.image.thumbnails.avif)} sizes="(max-width: 760px) calc(100vw - 32px), 360px" />
                      <source type="image/webp" srcset={srcset(item.image.thumbnails.webp)} sizes="(max-width: 760px) calc(100vw - 32px), 360px" />
                      <img
                        src={assetUrl(item.image.thumbnails.webp[0].path)}
                        alt={`Screenshot of ${item.title}`}
                        width={item.image.width}
                        height={item.image.height}
                        loading={index === 0 ? "eager" : "lazy"}
                        decoding={index === 0 ? "sync" : "async"}
                        fetchpriority={index === 0 ? "high" : undefined}
                      />
                      <span class="preview-badge" aria-hidden="true">Preview</span>
                    </picture>
                  </a>
                  <figcaption class="featured-copy">
                    <span>{tierName(item.tier)} / {item.kind}</span>
                    <strong>{item.title}</strong>
                    <em>{item.oneLine}</em>
                    <span class="hidden-caption-content">
                      <strong>{item.title}</strong>
                      <span>{tierName(item.tier)} / {item.kind}</span>
                      <span>{item.oneLine}</span>
                    </span>
                  </figcaption>
                </figure>
              </article>
            {/each}
          </div>
        </div>
      </div>
    </section>
  {/if}

  <section aria-labelledby="galleryTitle">
    <div class="section-heading">
      <div>
        <p class="section-kicker">Archive</p>
        <h2 id="galleryTitle">Experiment index</h2>
      </div>
      <p id="resultCount">Showing {filteredItems.length} of {galleryStats.total}</p>
    </div>

    <div class="gallery" id="galleryGrid" use:photoSwipeGallery>
      {#if visibleItems.length}
        {#each visibleItems as item, index (item.tier + ":" + item.slug)}
          <article class:deferred-card={index >= 8} class="toy-card">
            <figure class="toy-shot preview-frame">
              <a
                class="preview-link"
                href={previewHref(item)}
                data-pswp-src={previewHref(item)}
                data-pswp-srcset={previewSrcset(item)}
                data-pswp-width={previewImage(item).width}
                data-pswp-height={previewImage(item).height}
                target="_blank"
                rel="noopener"
                aria-label={`Preview screenshot of ${item.title}`}
              >
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
                  />
                  <span class="preview-badge" aria-hidden="true">Preview</span>
                </picture>
              </a>
              <figcaption class="hidden-caption-content">
                <strong>{item.title}</strong>
                <span>{tierName(item.tier)} / {item.kind}</span>
                <span>{item.oneLine}</span>
              </figcaption>
            </figure>
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
          data-tier={tier}
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

<footer class="site-footer">
  <div class="shell">Static GitHub Pages gallery for Drew-Goddyn/jules-toys.</div>
</footer>
