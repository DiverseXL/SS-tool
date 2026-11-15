(function () {
  'use strict';

  const view = document.getElementById('view');
  const sidebar = document.getElementById('sidebar');
  const menuToggle = document.getElementById('menu-toggle');
  const navBackdrop = document.getElementById('nav-backdrop');
  const accountEmail = document.getElementById('account-email');
  const logoutButton = document.getElementById('logout-button');
  const mobileQuery = window.matchMedia('(max-width: 900px)');

  const state = {
    session: null,
    renderSeq: 0,
    navOpen: false,
    importFile: null,
    redirecting: false,
    productRequest: 0,
    researchBusy: false,
    researchListSeq: 0,
    researchWorkspaceSeq: 0,
    researchResult: null,
    extractionResult: null,
    reviewBusy: false,
    reviewQueueSeq: 0,
    reviewDetailSeq: 0,
    reviewDecision: null,
    reviewOutcome: null,
  };

  const routes = {
    overview: { path: '/dashboard', title: 'Overview', nav: 'overview', render: renderOverview },
    products: {
      path: '/dashboard/products',
      title: 'Product catalogue',
      nav: 'products',
      render: renderCatalogue,
    },
    research: {
      path: '/dashboard/research',
      title: 'Research',
      nav: 'research',
      render: renderResearch,
    },
    review: {
      path: '/dashboard/review',
      title: 'Evidence review',
      nav: 'review',
      render: renderReview,
    },
    imports: { path: '/dashboard/import', title: 'Import catalogue', nav: 'import', render: renderImport },
  };

  class ApiError extends Error {
    constructor(message, status, code, details) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => {
      switch (character) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        default:
          return '&#39;';
      }
    });
  }

  function valueOrDash(value) {
    if (value === null || value === undefined || value === '') {
      return '<span class="value-empty">Not recorded</span>';
    }
    return escapeHtml(value);
  }

  function formatNumber(value) {
    const number = Number(value);
    return new Intl.NumberFormat('en-GB').format(Number.isFinite(number) ? number : 0);
  }

  function formatDate(value) {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not recorded';
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(date);
  }

  function formatDateTime(value) {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not recorded';
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  function safeHttpUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function redirectToLogin() {
    if (state.redirecting) return;
    state.redirecting = true;
    const next = window.location.pathname + window.location.search;
    window.location.assign(`/login?expired=1&next=${encodeURIComponent(next)}`);
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    if (typeof options.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    let response;
    try {
      response = await fetch(path, {
        credentials: 'same-origin',
        ...options,
        headers,
      });
    } catch {
      throw new ApiError('Could not reach the server. Check your connection.', 0, 'NETWORK_ERROR');
    }

    let body = null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await response.json().catch(() => null);
    }

    if (response.status === 401) {
      redirectToLogin();
      throw new ApiError('Your session has expired.', 401, 'AUTH_REQUIRED');
    }

    if (!response.ok) {
      const error = body && body.error ? body.error : {};
      throw new ApiError(
        error.message || `The request failed (${response.status}).`,
        response.status,
        error.code,
        error.details,
      );
    }

    return body;
  }

  function focusHeading() {
    window.requestAnimationFrame(() => {
      const heading = view.querySelector('h1');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
    });
  }

  function pageHeading(eyebrow, title, description, actions = '') {
    return `
      <header class="page-head">
        <div class="page-head-copy">
          <p class="eyebrow">${escapeHtml(eyebrow)}</p>
          <h1>${escapeHtml(title)}</h1>
          <p class="page-description">${description}</p>
        </div>
        ${actions ? `<div class="page-actions">${actions}</div>` : ''}
      </header>
    `;
  }

  function loadingBlock(label) {
    return `
      <div class="loading-block" role="status">
        <span class="loading-line" aria-hidden="true"></span>
        <p>${escapeHtml(label)}</p>
      </div>
    `;
  }

  function renderErrorState(message, options = {}) {
    const showRetry = options.retry !== false;
    view.innerHTML = `
      <section class="page">
        ${pageHeading('Retailer workspace', options.title || 'Something went wrong', '')}
        <div class="alert alert--error" role="alert">
          <p>${escapeHtml(message)}</p>
          ${options.hint ? `<p class="alert-hint">${escapeHtml(options.hint)}</p>` : ''}
        </div>
        <div class="form-actions">
          ${showRetry ? '<button class="button button--primary" type="button" data-retry>Try again</button>' : ''}
          ${options.resetHref ? `<a class="button button--secondary" href="${escapeHtml(options.resetHref)}" data-link>Clear filters</a>` : ''}
        </div>
      </section>
    `;
    const retry = view.querySelector('[data-retry]');
    if (retry) retry.addEventListener('click', () => renderRoute());
    focusHeading();
  }

  function navigate(path, options = {}) {
    if (options.replace) {
      window.history.replaceState({}, '', path);
    } else {
      window.history.pushState({}, '', path);
    }
    renderRoute();
  }

  function resolveRoute(pathname) {
    const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
    return Object.values(routes).find((route) => route.path === normalized) || null;
  }

  function closeNav(returnFocus = false) {
    state.navOpen = false;
    sidebar.classList.remove('is-open');
    navBackdrop.hidden = true;
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', 'Open navigation');
    document.body.classList.remove('nav-open');
    syncNavInert();
    if (returnFocus) menuToggle.focus();
  }

  function openNav() {
    state.navOpen = true;
    sidebar.classList.add('is-open');
    navBackdrop.hidden = false;
    menuToggle.setAttribute('aria-expanded', 'true');
    menuToggle.setAttribute('aria-label', 'Close navigation');
    document.body.classList.add('nav-open');
    syncNavInert();
    const firstLink = sidebar.querySelector('nav a');
    if (firstLink) firstLink.focus();
  }

  function syncNavInert() {
    if (mobileQuery.matches && !state.navOpen) {
      sidebar.setAttribute('inert', '');
    } else {
      sidebar.removeAttribute('inert');
    }
  }

  function setActiveNav(name) {
    document.querySelectorAll('[data-nav]').forEach((link) => {
      if (link.getAttribute('data-nav') === name) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  }

  function closeProductDialog() {
    const dialog = document.getElementById('product-dialog');
    if (dialog && dialog.open) dialog.close();
  }

  function renderRoute() {
    const route = resolveRoute(window.location.pathname);

    if (!route) {
      state.renderSeq += 1;
      document.title = 'Page not found — SS Tool';
      setActiveNav('');
      view.innerHTML = `
        <section class="page">
          ${pageHeading('Retailer workspace', 'Page not found', 'This dashboard page does not exist.')}
          <a class="button button--primary" href="/dashboard" data-link>Return to overview</a>
        </section>
      `;
      focusHeading();
      return;
    }

    state.renderSeq += 1;
    state.researchBusy = false;
    state.reviewBusy = false;
    closeProductDialog();
    closeNav();
    setActiveNav(route.nav);
    document.title = `${route.title} — SS Tool`;
    window.scrollTo({ top: 0, behavior: 'auto' });
    route.render(view, state.renderSeq);
  }

  function renderOverview(target, renderSeq) {
    target.innerHTML = `
      <section class="page" aria-labelledby="overview-title">
        ${pageHeading(
          'Retailer workspace',
          'Overview',
          'A live view of the catalogue and the evidence-review backlog. Metrics are calculated from PostgreSQL, not sampled or estimated.',
          `<a class="button button--secondary" href="/dashboard/products" data-link>View catalogue</a>
           <a class="button button--primary" href="/dashboard/import" data-link>Import catalogue</a>`,
        )}
        <div id="overview-body">
          ${loadingBlock('Loading catalogue and review totals…')}
        </div>
      </section>
    `;

    loadOverview(renderSeq);
  }

  async function loadOverview(renderSeq) {
    try {
      const body = await api('/api/v1/dashboard/summary');
      if (renderSeq !== state.renderSeq) return;

      const summary = body && body.data ? body.data : null;
      if (
        !summary ||
        !summary.products ||
        !summary.manufacturers ||
        !summary.evidence ||
        !Array.isArray(summary.recentProducts)
      ) {
        throw new ApiError('The server returned an unexpected summary response.', 500, 'INVALID_RESPONSE');
      }

      const total = Number(summary.products.total) || 0;
      const withSources = Number(summary.products.withSources) || 0;
      const withoutSources = Number(summary.products.withoutSources) || 0;
      const reviewedProducts = Number(summary.products.withAcceptedEvidence) || 0;
      const manufacturers = Number(summary.manufacturers.total) || 0;
      const pendingEvidence = Number(summary.evidence.pendingReview) || 0;
      const coverage = total === 0 ? 0 : Math.min(100, Math.round((withSources / total) * 100));

      const container = document.getElementById('overview-body');
      if (!container) return;

      const recentRows = summary.recentProducts
        .map(
          (product) => `
            <tr>
              <td data-label="Product">
                <span class="cell-primary">${escapeHtml(product.name)}</span>
                <span class="cell-sub">${escapeHtml(product.manufacturer?.name || 'Manufacturer not recorded')}</span>
              </td>
              <td data-label="Model"><code>${valueOrDash(product.modelIdentifier)}</code></td>
              <td data-label="Category">${valueOrDash(product.category)}</td>
              <td data-label="Added"><time datetime="${escapeHtml(product.createdAt)}">${formatDate(product.createdAt)}</time></td>
            </tr>
          `,
        )
        .join('');

      container.innerHTML = `
        <div class="metric-grid">
          <article class="metric">
            <p class="metric-label">Products</p>
            <p class="metric-value">${formatNumber(total)}</p>
            <p class="metric-detail">Catalogue records across ${formatNumber(manufacturers)} manufacturers.</p>
          </article>
          <article class="metric">
            <p class="metric-label">Source discovery</p>
            <p class="metric-value">${formatNumber(withSources)}<span class="metric-of"> of ${formatNumber(total)}</span></p>
            <p class="metric-detail">${coverage}% of products have at least one associated manufacturer source.</p>
          </article>
          <article class="metric metric--attention">
            <p class="metric-label">Awaiting review</p>
            <p class="metric-value">${formatNumber(pendingEvidence)}</p>
            <p class="metric-detail">Evidence records pending a human review decision.</p>
          </article>
          <article class="metric">
            <p class="metric-label">Reviewed products</p>
            <p class="metric-value">${formatNumber(reviewedProducts)}</p>
            <p class="metric-detail">Products with at least one accepted evidence record.</p>
          </article>
        </div>

        <p class="metric-caveat">
          A discovered source is not a researched or verified product. Accepted evidence records a
          reviewed manufacturer statement; it does not certify that a product is secure.
        </p>

        <div class="overview-grid">
          <section class="panel" aria-labelledby="coverage-title">
            <div class="panel-head">
              <div>
                <p class="eyebrow">Source discovery</p>
                <h2 id="coverage-title">Catalogue coverage</h2>
              </div>
              <span class="status-pill">${coverage}% sourced</span>
            </div>

            <div class="coverage-numbers">
              <div>
                <span class="coverage-value">${formatNumber(withSources)}</span>
                <span class="coverage-label">With at least one source</span>
              </div>
              <div>
                <span class="coverage-value">${formatNumber(withoutSources)}</span>
                <span class="coverage-label">Without discovered sources</span>
              </div>
            </div>

            <div
              class="coverage-track"
              role="progressbar"
              aria-label="Products with at least one discovered source"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow="${coverage}"
              aria-valuetext="${formatNumber(withSources)} of ${formatNumber(total)} products"
            >
              <span class="coverage-fill" style="width: ${coverage}%"></span>
            </div>

            <p class="panel-note">
              Source discovery records manufacturer pages that exist for a product. Research and
              evidence extraction are separate, later steps.
            </p>
          </section>

          <section class="panel panel--workload" aria-labelledby="workload-title">
            <div class="panel-head">
              <div>
                <p class="eyebrow">Evidence review</p>
                <h2 id="workload-title">Review workload</h2>
              </div>
            </div>
            <p class="workload-value">${formatNumber(pendingEvidence)}</p>
            <p class="workload-copy">evidence records are waiting for a human decision.</p>
            <p class="panel-note">
              This overview is read-only. Open the evidence review queue to inspect quotations,
              conflicts and record a human decision.
            </p>
            <a class="text-link" href="/dashboard/review" data-link>Open evidence review queue</a>
          </section>
        </div>

        <section class="panel" aria-labelledby="recent-title">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Newest records</p>
              <h2 id="recent-title">Recently added products</h2>
            </div>
            <a class="text-link" href="/dashboard/products" data-link>All products</a>
          </div>
          ${
            total === 0
              ? `<div class="empty-state empty-state--compact">
                   <h3>No products in the catalogue yet</h3>
                   <p>Import a CSV with manufacturer and product rows to start building the workspace.</p>
                   <a class="button button--primary" href="/dashboard/import" data-link>Import a catalogue</a>
                 </div>`
              : summary.recentProducts.length === 0
                ? '<p class="muted">No recent products to display.</p>'
                : `<div class="table-wrap">
                     <table class="data-table">
                       <caption class="visually-hidden">Five most recently added products</caption>
                       <thead>
                         <tr>
                           <th scope="col">Product</th>
                           <th scope="col">Model</th>
                           <th scope="col">Category</th>
                           <th scope="col">Added</th>
                         </tr>
                       </thead>
                       <tbody>${recentRows}</tbody>
                     </table>
                   </div>`
          }
        </section>

        <section class="shortcut-grid" aria-label="Common tasks">
          <a class="shortcut" href="/dashboard/import" data-link>
            <span class="shortcut-kicker">Catalogue</span>
            <strong>Import manufacturer and product rows</strong>
            <span>Upload a CSV, review validation errors and see exactly what was created.</span>
          </a>
          <a class="shortcut" href="/dashboard/products" data-link>
            <span class="shortcut-kicker">Catalogue</span>
            <strong>Browse the product catalogue</strong>
            <span>Filter by manufacturer, page through records and open a product's details.</span>
          </a>
        </section>
      `;
      focusHeading();
    } catch (error) {
      if (renderSeq !== state.renderSeq) return;
      if (error instanceof ApiError && error.status === 401) return;
      renderErrorState(error.message || 'The dashboard summary could not be loaded.');
    }
  }

  function parseCatalogueQuery() {
    const params = new URLSearchParams(window.location.search);
    const pageValue = Number(params.get('page'));
    const page = Number.isInteger(pageValue) && pageValue > 0 ? pageValue : 1;
    const manufacturerId = params.get('manufacturerId') || '';
    return { page, manufacturerId };
  }

  function productsPath(page, manufacturerId) {
    const params = new URLSearchParams();
    params.set('page', String(page));
    if (manufacturerId) params.set('manufacturerId', manufacturerId);
    return `/dashboard/products?${params.toString()}`;
  }

  function renderCatalogue(target, renderSeq) {
    const { page, manufacturerId } = parseCatalogueQuery();

    target.innerHTML = `
      <section class="page" aria-labelledby="catalogue-title">
        ${pageHeading(
          'Catalogue',
          'Product catalogue',
          'Every product record in this workspace, with the manufacturer and identifiers stored in PostgreSQL.',
          `<a class="button button--primary" href="/dashboard/import" data-link>Import catalogue</a>`,
        )}
        <div id="catalogue-body">
          ${loadingBlock('Loading products and manufacturers…')}
        </div>
      </section>
    `;

    loadCatalogue(renderSeq, page, manufacturerId);
  }

  async function loadCatalogue(renderSeq, page, manufacturerId) {
    const query = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (manufacturerId) query.set('manufacturerId', manufacturerId);

    try {
      const [manufacturerBody, productBody] = await Promise.all([
        api('/api/v1/manufacturers'),
        api(`/api/v1/products?${query.toString()}`),
      ]);

      if (renderSeq !== state.renderSeq) return;

      const manufacturers = Array.isArray(manufacturerBody?.data) ? manufacturerBody.data : [];
      const products = Array.isArray(productBody?.data) ? productBody.data : [];
      const pagination = productBody?.pagination;

      if (!pagination || typeof pagination.total !== 'number') {
        throw new ApiError('The server returned an unexpected product list response.', 500, 'INVALID_RESPONSE');
      }

      const manufacturerNames = new Map(
        manufacturers.map((manufacturer) => [manufacturer.id, manufacturer.name]),
      );

      const container = document.getElementById('catalogue-body');
      if (!container) return;

      const options = manufacturers
        .map(
          (manufacturer) =>
            `<option value="${escapeHtml(manufacturer.id)}"${
              manufacturer.id === manufacturerId ? ' selected' : ''
            }>${escapeHtml(manufacturer.name)}</option>`,
        )
        .join('');

      const rows = products
        .map((product) => {
          const manufacturerName =
            manufacturerNames.get(product.manufacturerId) || 'Unknown manufacturer';
          return `
            <tr>
              <td data-label="Product">
                <button
                  class="product-link"
                  type="button"
                  data-open-product="${escapeHtml(product.id)}"
                  data-product-name="${escapeHtml(product.name)}"
                >${escapeHtml(product.name)}</button>
              </td>
              <td data-label="Manufacturer">${escapeHtml(manufacturerName)}</td>
              <td data-label="Model"><code>${valueOrDash(product.modelIdentifier)}</code></td>
              <td data-label="GTIN"><code>${valueOrDash(product.gtin)}</code></td>
              <td data-label="Category">${valueOrDash(product.category)}</td>
              <td data-label="Added"><time datetime="${escapeHtml(product.createdAt)}">${formatDate(product.createdAt)}</time></td>
            </tr>
          `;
        })
        .join('');

      const totalPages = Number(pagination.totalPages) || 0;
      const total = Number(pagination.total) || 0;
      const isFiltered = Boolean(manufacturerId);

      const paginationControls =
        totalPages > 0
          ? `<nav class="pagination" aria-label="Product catalogue pages">
               ${
                 page > 1
                   ? `<a class="button button--quiet" href="${productsPath(page - 1, manufacturerId)}" data-link rel="prev">Previous</a>`
                   : '<span class="button button--quiet is-disabled" aria-disabled="true">Previous</span>'
               }
               <span class="pagination-status">Page ${formatNumber(page)} of ${formatNumber(totalPages)}</span>
               ${
                 page < totalPages
                   ? `<a class="button button--quiet" href="${productsPath(page + 1, manufacturerId)}" data-link rel="next">Next</a>`
                   : '<span class="button button--quiet is-disabled" aria-disabled="true">Next</span>'
               }
             </nav>`
          : '';

      container.innerHTML = `
        <div class="toolbar">
          <div class="field field--inline">
            <label for="manufacturer-filter">Manufacturer</label>
            <select id="manufacturer-filter" name="manufacturerId">
              <option value="">All manufacturers</option>
              ${options}
            </select>
          </div>
          <p class="toolbar-meta">
            ${
              total === 0
                ? 'No matching products'
                : `${formatNumber(total)} product${total === 1 ? '' : 's'}${isFiltered ? ' for this manufacturer' : ''}`
            }
          </p>
        </div>

        ${
          total === 0
            ? `<div class="empty-state">
                 <p class="empty-kicker">${isFiltered ? 'No matches' : 'Catalogue empty'}</p>
                 <h2>${isFiltered ? 'No products for this manufacturer' : 'No products yet'}</h2>
                 <p>${
                   isFiltered
                     ? 'Choose another manufacturer or clear the filter to see the full catalogue.'
                     : 'Import a CSV catalogue to add manufacturer and product records.'
                 }</p>
                 <div class="form-actions">
                   ${
                     isFiltered
                       ? '<a class="button button--secondary" href="/dashboard/products" data-link>Clear filter</a>'
                       : '<a class="button button--primary" href="/dashboard/import" data-link>Import a catalogue</a>'
                   }
                 </div>
               </div>`
            : products.length === 0
              ? `<div class="empty-state">
                   <h2>No products on this page</h2>
                   <p>This page is past the end of the catalogue.</p>
                   <a class="button button--secondary" href="${productsPath(1, manufacturerId)}" data-link>Return to page one</a>
                 </div>`
              : `<div class="table-wrap">
                   <table class="data-table data-table--products">
                     <caption class="visually-hidden">Product catalogue</caption>
                     <thead>
                       <tr>
                         <th scope="col">Product</th>
                         <th scope="col">Manufacturer</th>
                         <th scope="col">Model</th>
                         <th scope="col">GTIN</th>
                         <th scope="col">Category</th>
                         <th scope="col">Added</th>
                       </tr>
                     </thead>
                     <tbody>${rows}</tbody>
                   </table>
                 </div>
                 ${paginationControls}`
        }

        <p class="panel-note panel-note--footer">
          Product search is not available yet; the catalogue can be filtered by manufacturer and
          paged. Open a product name to see its stored record.
        </p>
      `;

      const filter = document.getElementById('manufacturer-filter');
      if (filter) {
        filter.addEventListener('change', () => {
          navigate(productsPath(1, filter.value));
        });
      }

      container.querySelectorAll('[data-open-product]').forEach((button) => {
        button.addEventListener('click', () => {
          openProductDialog(button.getAttribute('data-open-product'), button);
        });
      });

      focusHeading();
    } catch (error) {
      if (renderSeq !== state.renderSeq) return;
      if (error instanceof ApiError && error.status === 401) return;

      if (error instanceof ApiError && error.status === 400) {
        renderErrorState(
          'The catalogue query is not valid. The page number or manufacturer filter may be malformed.',
          { title: 'Catalogue could not load', resetHref: '/dashboard/products' },
        );
        return;
      }

      renderErrorState(error.message || 'The product catalogue could not be loaded.');
    }
  }

  function ensureProductDialog() {
    let dialog = document.getElementById('product-dialog');
    if (dialog) return dialog;

    dialog = document.createElement('dialog');
    dialog.id = 'product-dialog';
    dialog.className = 'drawer';
    dialog.setAttribute('aria-labelledby', 'product-dialog-title');
    dialog.innerHTML = `
      <div class="drawer-head">
        <p class="eyebrow">Product record</p>
        <div class="drawer-head-row">
          <h2 id="product-dialog-title">Product</h2>
          <button class="icon-button" type="button" data-close-dialog aria-label="Close product details">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <p id="product-dialog-maker" class="drawer-subtitle"></p>
      </div>
      <div id="product-detail-body" class="drawer-body"></div>
    `;
    document.body.appendChild(dialog);

    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.querySelector('[data-close-dialog]').addEventListener('click', () => dialog.close());

    return dialog;
  }

  async function openProductDialog(productId, trigger) {
    if (!productId) return;
    const dialog = ensureProductDialog();
    const body = document.getElementById('product-detail-body');
    const title = document.getElementById('product-dialog-title');
    const maker = document.getElementById('product-dialog-maker');
    const requestId = ++state.productRequest;

    title.textContent = trigger.getAttribute('data-product-name') || 'Product';
    maker.textContent = '';
    body.innerHTML = '<p class="muted" role="status">Loading the stored product record…</p>';

    if (!dialog.open) dialog.showModal();

    try {
      const response = await api(`/api/v1/products/${encodeURIComponent(productId)}`);
      if (requestId !== state.productRequest || !dialog.open) return;
      const product = response && response.data ? response.data : null;

      if (!product || !product.id) {
        throw new ApiError('The product record was not returned.', 404, 'PRODUCT_NOT_FOUND');
      }

      const manufacturer = product.manufacturer || {};
      title.textContent = product.name;
      maker.textContent = manufacturer.name || 'Manufacturer not recorded';

      const productUrl = safeHttpUrl(product.productUrl);

      body.innerHTML = `
        <dl class="detail-list">
          <div><dt>Manufacturer</dt><dd>${valueOrDash(manufacturer.name)}</dd></div>
          <div><dt>Product</dt><dd>${valueOrDash(product.name)}</dd></div>
          <div><dt>Model identifier</dt><dd><code>${valueOrDash(product.modelIdentifier)}</code></dd></div>
          <div><dt>GTIN</dt><dd><code>${valueOrDash(product.gtin)}</code></dd></div>
          <div><dt>SKU</dt><dd><code>${valueOrDash(product.sku)}</code></dd></div>
          <div><dt>Category</dt><dd>${valueOrDash(product.category)}</dd></div>
          <div><dt>Market region</dt><dd>${valueOrDash(product.marketRegion)}</dd></div>
          <div><dt>Product URL</dt><dd>${
            productUrl
              ? `<a href="${escapeHtml(productUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(productUrl)}</a>`
              : '<span class="value-empty">Not recorded</span>'
          }</dd></div>
          <div><dt>Added</dt><dd>${formatDateTime(product.createdAt)}</dd></div>
          <div><dt>Last updated</dt><dd>${formatDateTime(product.updatedAt)}</dd></div>
        </dl>
        <div class="record-id">
          <span>Record ID</span>
          <code>${escapeHtml(product.id)}</code>
        </div>
        <p class="panel-note">
          Source discovery, research and evidence review are separate workflow phases. This panel
          shows only the stored catalogue record.
        </p>
        <a class="button button--secondary" href="/dashboard/products" data-link>Back to catalogue</a>
      `;
    } catch (error) {
      if (requestId !== state.productRequest || !dialog.open) return;
      if (error instanceof ApiError && error.status === 401) {
        dialog.close();
        return;
      }
      body.innerHTML = `<div class="alert alert--error" role="alert">${escapeHtml(
        error.message || 'The product details could not be loaded.',
      )}</div>`;
    }
  }

  function parseResearchQuery() {
    const params = new URLSearchParams(window.location.search);
    const pageValue = Number(params.get('page'));
    return {
      page: Number.isInteger(pageValue) && pageValue > 0 ? pageValue : 1,
      manufacturerId: params.get('manufacturerId') || '',
      productId: params.get('productId') || '',
    };
  }

  function researchPath(page, manufacturerId, productId) {
    const params = new URLSearchParams();
    if (page > 1) params.set('page', String(page));
    if (manufacturerId) params.set('manufacturerId', manufacturerId);
    if (productId) params.set('productId', productId);
    const query = params.toString();
    return `/dashboard/research${query ? `?${query}` : ''}`;
  }

  function researchStatusLabel(status) {
    switch (status) {
      case 'sources_fetched':
        return 'Sources fetched';
      case 'candidates_only':
        return 'Candidates only';
      default:
        return 'Not researched';
    }
  }

  function researchStatusClass(status) {
    switch (status) {
      case 'sources_fetched':
        return 'status-pill--good';
      case 'candidates_only':
        return 'status-pill--attention';
      default:
        return '';
    }
  }

  function relationshipLabel(role) {
    switch (role) {
      case 'manufacturer_homepage':
        return 'Manufacturer homepage';
      case 'product_page':
        return 'Product page';
      case 'support_page':
        return 'Support page';
      case 'security_advisory':
        return 'Security advisory';
      case 'policy_page':
        return 'Policy page';
      case 'discovered_candidate':
        return 'External candidate';
      default:
        return role;
    }
  }

  function claimTypeLabel(type) {
    switch (type) {
      case 'support_start':
        return 'Support start';
      case 'support_end':
        return 'Support end';
      case 'os_version':
        return 'Operating system';
      case 'policy':
        return 'Support policy';
      default:
        return type;
    }
  }

  function extractionSkipLabel(reason) {
    switch (reason) {
      case 'discovered_candidate':
        return 'External candidate, never fetched';
      case 'empty_content':
        return 'No stored page text';
      case 'not_successfully_fetched':
        return 'Page was not successfully fetched';
      case 'third_party_source':
        return 'Third-party source outside the manufacturer domain';
      case 'source_limit':
        return 'Beyond the five-source extraction limit';
      default:
        return reason;
    }
  }

  function reviewReasonLabel(reason) {
    switch (reason) {
      case 'robots_disallowed':
        return 'Blocked by robots.txt';
      case 'limit_reached':
        return 'Page limit reached';
      case 'unsafe_destination':
        return 'Unsafe destination';
      default:
        return reason;
    }
  }

  function sourceLink(source) {
    const url = safeHttpUrl(source && source.url);
    const label = source && (source.title || source.domain || source.url);
    if (!url) return `<span class="mono">${escapeHtml(label || 'Source URL unavailable')}</span>`;
    return `<a class="source-url" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  }

  function renderResearch(target, renderSeq) {
    const { page, manufacturerId, productId } = parseResearchQuery();

    if (state.researchResult && state.researchResult.productId !== productId) {
      state.researchResult = null;
    }
    if (state.extractionResult && state.extractionResult.productId !== productId) {
      state.extractionResult = null;
    }

    target.innerHTML = `
      <section class="page" aria-labelledby="research-title">
        ${pageHeading(
          'Research workbench',
          'Manufacturer research',
          'Select a catalogue product, discover its manufacturer pages, then extract support statements for human review. Research and extraction are explicit server operations; nothing is inferred in the browser.',
          `<a class="button button--secondary" href="/dashboard/products" data-link>Product catalogue</a>`,
        )}

        <ol class="workflow-steps" aria-label="Research workflow">
          <li><span>01</span><div><strong>Select product</strong><small>Choose a catalogue record.</small></div></li>
          <li><span>02</span><div><strong>Research manufacturer</strong><small>Fetch registered manufacturer pages.</small></div></li>
          <li><span>03</span><div><strong>Review source pages</strong><small>Inspect what was fetched and what was not.</small></div></li>
          <li><span>04</span><div><strong>Extract support information</strong><small>Trace quotations to stored source text.</small></div></li>
          <li><span>05</span><div><strong>Send to evidence review</strong><small>New claims stay pending a human decision.</small></div></li>
        </ol>

        <section class="panel" aria-labelledby="research-products-title">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Step 1</p>
              <h2 id="research-products-title">Select a product</h2>
            </div>
            <span id="research-product-count" class="status-pill">Loading…</span>
          </div>
          <div id="research-products">
            ${loadingBlock('Loading products, manufacturers and stored research records…')}
          </div>
        </section>

        <section id="research-workspace" class="research-workspace" aria-label="Selected product research workspace" aria-live="polite">
          <div class="empty-state">
            <p class="empty-kicker">No product selected</p>
            <h2>Open a product to begin</h2>
            <p>Select a product above to inspect its persisted sources and evidence, or to start a new research run.</p>
          </div>
        </section>
      </section>
    `;

    loadResearchProducts(renderSeq, page, manufacturerId, productId);
    if (productId) {
      loadResearchWorkspace(renderSeq, productId);
    } else {
      state.researchWorkspaceSeq += 1;
    }
  }

  async function loadResearchProducts(renderSeq, page, manufacturerId, selectedProductId) {
    const requestSeq = ++state.researchListSeq;
    const query = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (manufacturerId) query.set('manufacturerId', manufacturerId);

    try {
      const [manufacturerBody, productBody] = await Promise.all([
        api('/api/v1/manufacturers'),
        api(`/api/v1/dashboard/research/products?${query.toString()}`),
      ]);

      if (requestSeq !== state.researchListSeq || renderSeq !== state.renderSeq) return;

      const manufacturers = Array.isArray(manufacturerBody?.data) ? manufacturerBody.data : [];
      const products = Array.isArray(productBody?.data) ? productBody.data : [];
      const pagination = productBody?.pagination;

      if (
        !pagination ||
        typeof pagination.total !== 'number' ||
        products.some(
          (product) =>
            !product.research ||
            typeof product.research.sourceCount !== 'number' ||
            typeof product.research.evidenceCount !== 'number',
        )
      ) {
        throw new ApiError('The server returned an unexpected research product response.', 500, 'INVALID_RESPONSE');
      }

      const container = document.getElementById('research-products');
      if (!container) return;

      const count = document.getElementById('research-product-count');
      if (count) {
        count.textContent = `${formatNumber(pagination.total)} product${pagination.total === 1 ? '' : 's'}`;
      }

      const options = manufacturers
        .map(
          (manufacturer) =>
            `<option value="${escapeHtml(manufacturer.id)}"${
              manufacturer.id === manufacturerId ? ' selected' : ''
            }>${escapeHtml(manufacturer.name)}</option>`,
        )
        .join('');

      const rows = products
        .map((product) => {
          const research = product.research;
          const website = safeHttpUrl(product.manufacturer?.website);
          return `
            <tr class="${product.id === selectedProductId ? 'is-selected' : ''}">
              <td data-label="Product">
                <button
                  class="product-link"
                  type="button"
                  data-select-research-product="${escapeHtml(product.id)}"
                >${escapeHtml(product.name)}</button>
                <span class="cell-sub">${escapeHtml(product.category || 'Category not recorded')}</span>
              </td>
              <td data-label="Manufacturer">${escapeHtml(product.manufacturer?.name || 'Manufacturer not recorded')}</td>
              <td data-label="Model"><code>${valueOrDash(product.modelIdentifier)}</code></td>
              <td data-label="Website">${
                website
                  ? `<a class="table-link" href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer">${escapeHtml(product.manufacturer.website)}</a>`
                  : '<span class="value-empty">Not registered</span>'
              }</td>
              <td data-label="Research">
                <span class="status-pill ${researchStatusClass(research.status)}">${escapeHtml(researchStatusLabel(research.status))}</span>
                <span class="cell-sub">${research.lastActivityAt ? `Last activity ${formatDate(research.lastActivityAt)}` : 'No stored activity'}</span>
              </td>
              <td data-label="Sources">
                ${formatNumber(research.fetchedSourceCount)} fetched
                <span class="cell-sub">${formatNumber(research.sourceCount)} recorded · ${formatNumber(research.candidateCount)} candidate${research.candidateCount === 1 ? '' : 's'}</span>
              </td>
              <td data-label="Evidence">${formatNumber(research.evidenceCount)}</td>
            </tr>
          `;
        })
        .join('');

      const totalPages = Number(pagination.totalPages) || 0;
      const total = Number(pagination.total) || 0;
      const isFiltered = Boolean(manufacturerId);

      const paginationControls =
        totalPages > 0
          ? `<nav class="pagination" aria-label="Research product pages">
               ${
                 page > 1
                   ? `<a class="button button--quiet" href="${researchPath(page - 1, manufacturerId, '')}" data-link rel="prev">Previous</a>`
                   : '<span class="button button--quiet is-disabled" aria-disabled="true">Previous</span>'
               }
               <span class="pagination-status">Page ${formatNumber(page)} of ${formatNumber(totalPages)}</span>
               ${
                 page < totalPages
                   ? `<a class="button button--quiet" href="${researchPath(page + 1, manufacturerId, '')}" data-link rel="next">Next</a>`
                   : '<span class="button button--quiet is-disabled" aria-disabled="true">Next</span>'
               }
             </nav>`
          : '';

      container.innerHTML = `
        <div class="toolbar">
          <div class="field field--inline">
            <label for="research-manufacturer-filter">Manufacturer</label>
            <select id="research-manufacturer-filter">
              <option value="">All manufacturers</option>
              ${options}
            </select>
          </div>
          <p class="toolbar-meta">
            ${total === 0 ? 'No matching products' : `${formatNumber(total)} product${total === 1 ? '' : 's'}${isFiltered ? ' for this manufacturer' : ''}`}
          </p>
        </div>

        ${
          total === 0
            ? `<div class="empty-state">
                 <p class="empty-kicker">${isFiltered ? 'No matches' : 'Catalogue empty'}</p>
                 <h2>${isFiltered ? 'No products for this manufacturer' : 'No products available'}</h2>
                 <p>${isFiltered ? 'Clear the manufacturer filter to see the full catalogue.' : 'Import a catalogue before starting manufacturer research.'}</p>
                 <div class="form-actions">
                   ${
                     isFiltered
                       ? '<a class="button button--secondary" href="/dashboard/research" data-link>Clear filter</a>'
                       : '<a class="button button--primary" href="/dashboard/import" data-link>Import catalogue</a>'
                   }
                 </div>
               </div>`
            : products.length === 0
              ? `<div class="empty-state"><h2>No products on this page</h2><p>This page is past the end of the catalogue.</p><a class="button button--secondary" href="${researchPath(1, manufacturerId, '')}" data-link>Return to page one</a></div>`
              : `<div class="table-wrap research-product-table">
                   <table class="data-table data-table--research-products">
                     <caption class="visually-hidden">Products available for manufacturer research</caption>
                     <thead>
                       <tr>
                         <th scope="col">Product</th>
                         <th scope="col">Manufacturer</th>
                         <th scope="col">Model</th>
                         <th scope="col">Website</th>
                         <th scope="col">Research</th>
                         <th scope="col">Sources</th>
                         <th scope="col">Evidence</th>
                       </tr>
                     </thead>
                     <tbody>${rows}</tbody>
                   </table>
                 </div>
                 ${paginationControls}`
        }

        <p class="panel-note research-table-note">
          Status, source counts and evidence counts come from stored PostgreSQL records. No research
          status is inferred in the browser.
        </p>
      `;

      const filter = document.getElementById('research-manufacturer-filter');
      if (filter) {
        filter.addEventListener('change', () => {
          navigate(researchPath(1, filter.value, ''));
        });
      }

      container.querySelectorAll('[data-select-research-product]').forEach((button) => {
        button.addEventListener('click', () => {
          navigate(
            researchPath(page, manufacturerId, button.getAttribute('data-select-research-product')),
          );
        });
      });
    } catch (error) {
      if (requestSeq !== state.researchListSeq || renderSeq !== state.renderSeq) return;
      if (error instanceof ApiError && error.status === 401) return;

      const container = document.getElementById('research-products');
      if (!container) return;
      container.innerHTML = `
        <div class="alert alert--error" role="alert">
          <p>${escapeHtml(error.message || 'The research product list could not be loaded.')}</p>
        </div>
        <div class="form-actions">
          <button class="button button--secondary" type="button" data-retry-research-products>Try again</button>
        </div>
      `;
      const retry = container.querySelector('[data-retry-research-products]');
      if (retry) {
        retry.addEventListener('click', () => {
          container.innerHTML = loadingBlock('Reloading products and stored research records…');
          loadResearchProducts(renderSeq, page, manufacturerId, selectedProductId);
        });
      }
    }
  }

  async function loadResearchWorkspace(renderSeq, productId, options = {}) {
    const requestSeq = ++state.researchWorkspaceSeq;
    const workspace = document.getElementById('research-workspace');
    if (!workspace) return;

    workspace.innerHTML = loadingBlock('Loading the stored product, source and evidence records…');

    try {
      const [productBody, sourceBody, evidenceBody] = await Promise.all([
        api(`/api/v1/products/${encodeURIComponent(productId)}`),
        api(`/api/v1/products/${encodeURIComponent(productId)}/sources`),
        api(`/api/v1/products/${encodeURIComponent(productId)}/evidence?page=1&pageSize=50`),
      ]);

      if (requestSeq !== state.researchWorkspaceSeq || renderSeq !== state.renderSeq) return;

      const product = productBody && productBody.data ? productBody.data : null;
      const sources = Array.isArray(sourceBody?.data) ? sourceBody.data : null;
      const evidenceItems = Array.isArray(evidenceBody?.data) ? evidenceBody.data : null;

      if (!product || !product.id || !sources || !evidenceItems) {
        throw new ApiError('The server returned an unexpected research workspace response.', 500, 'INVALID_RESPONSE');
      }

      const pagination = evidenceBody.pagination || {
        total: evidenceItems.length,
        page: 1,
        pageSize: 50,
        totalPages: evidenceItems.length > 0 ? 1 : 0,
      };

      workspace.innerHTML = renderResearchWorkspace(product, sources, evidenceItems, pagination);
      wireResearchWorkspace(product, sources, renderSeq);

      if (options.focusResult) {
        const heading = workspace.querySelector('#research-run-title, #extraction-run-title');
        if (heading) {
          heading.setAttribute('tabindex', '-1');
          heading.focus({ preventScroll: true });
          heading.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
      }
    } catch (error) {
      if (requestSeq !== state.researchWorkspaceSeq || renderSeq !== state.renderSeq) return;
      if (error instanceof ApiError && error.status === 401) return;

      const notFound = error instanceof ApiError && error.status === 404;
      workspace.innerHTML = `
        <div class="panel">
          <div class="alert alert--error" role="alert">
            <p>${escapeHtml(
              notFound
                ? 'That product no longer exists in the catalogue.'
                : error.message || 'The research workspace could not be loaded.',
            )}</p>
          </div>
          <div class="form-actions">
            <button class="button button--secondary" type="button" data-retry-research-workspace>Try again</button>
            <a class="button button--quiet" href="/dashboard/research" data-link>Choose another product</a>
          </div>
        </div>
      `;
      const retry = workspace.querySelector('[data-retry-research-workspace]');
      if (retry) {
        retry.addEventListener('click', () => loadResearchWorkspace(renderSeq, productId));
      }
    }
  }

  function renderResearchWorkspace(product, sources, evidenceItems, evidencePagination) {
    const manufacturer = product.manufacturer || {};
    const website = safeHttpUrl(manufacturer.website);
    const fetchedSources = sources.filter((source) => source.isFetched);
    const candidateSources = sources.filter((source) => source.isExternalCandidate);
    const eligibleSources = fetchedSources.filter(
      (source) => source.hasContent && !source.isExternalCandidate,
    );
    const status =
      fetchedSources.length > 0
        ? 'sources_fetched'
        : sources.length > 0
          ? 'candidates_only'
          : 'not_researched';
    const researchBlocked = !manufacturer.website;
    const extractionBlocked = eligibleSources.length === 0;
    const researchResult =
      state.researchResult && state.researchResult.productId === product.id
        ? state.researchResult.data
        : null;
    const extractionResult =
      state.extractionResult && state.extractionResult.productId === product.id
        ? state.extractionResult.data
        : null;
    const evidenceTotal = Number(evidencePagination.total) || evidenceItems.length;

    let extractionReason = '';
    if (sources.length === 0) {
      extractionReason = 'Research the manufacturer first. Extraction requires at least one fetched source with stored page text.';
    } else if (candidateSources.length === sources.length) {
      extractionReason = 'Only external candidates have been recorded. They were not fetched and cannot be sent to extraction.';
    } else if (eligibleSources.length === 0) {
      extractionReason = 'No fetched manufacturer source has stored page text yet, so extraction is unavailable.';
    }

    return `
      <div class="workspace-head">
        <div class="workspace-head-copy">
          <p class="eyebrow">Step 2 · Research workspace</p>
          <h2 id="workspace-title" tabindex="-1">${escapeHtml(product.name)}</h2>
          <p class="workspace-subtitle">
            ${escapeHtml(manufacturer.name || 'Manufacturer not recorded')}
            ${product.modelIdentifier ? ` · <code>${escapeHtml(product.modelIdentifier)}</code>` : ''}
          </p>
          <p class="workspace-website">
            ${
              website
                ? `Manufacturer website: <a href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer">${escapeHtml(manufacturer.website)}</a>`
                : '<span class="value-empty">No manufacturer website is registered.</span>'
            }
          </p>
        </div>
        <span class="status-pill ${researchStatusClass(status)}">${escapeHtml(researchStatusLabel(status))}</span>
      </div>

      <div class="workspace-summary" aria-label="Stored research totals">
        <span><strong>${formatNumber(fetchedSources.length)}</strong> fetched source${fetchedSources.length === 1 ? '' : 's'}</span>
        <span><strong>${formatNumber(candidateSources.length)}</strong> external candidate${candidateSources.length === 1 ? '' : 's'}</span>
        <span><strong>${formatNumber(evidenceTotal)}</strong> stored claim${evidenceTotal === 1 ? '' : 's'}</span>
        <span><strong>${formatNumber(eligibleSources.length)}</strong> eligible for extraction</span>
      </div>

      ${
        researchBlocked
          ? `<div class="alert alert--attention" role="status">
               <p><strong>Research cannot start for this product.</strong> Its manufacturer has no registered website, so there is no host to research safely. Add the manufacturer website through the catalogue import or manufacturer record first.</p>
             </div>`
          : ''
      }

      <div class="research-actions">
        <div class="research-action">
          <button
            id="research-button"
            class="button button--primary"
            type="button"
            ${researchBlocked ? 'disabled data-base-disabled="true"' : ''}
            ${researchBlocked ? 'aria-describedby="research-blocked-note"' : ''}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="11" cy="11" r="8"></circle>
              <path d="m21 21-4.3-4.3"></path>
              <path d="M11 7v8"></path>
              <path d="M7 11h8"></path>
            </svg>
            <span data-button-label>Research manufacturer</span>
          </button>
          <p id="research-blocked-note" class="action-note">
            ${researchBlocked ? 'A registered manufacturer website is required.' : `Fetches up to five pages from ${escapeHtml(website ? new URL(website).hostname : 'the registered website')} and records what it finds.`}
          </p>
        </div>
        <div class="research-action">
          <button
            id="extract-button"
            class="button button--secondary"
            type="button"
            ${extractionBlocked ? 'disabled data-base-disabled="true"' : ''}
            ${extractionBlocked ? 'aria-describedby="extraction-blocked-note"' : ''}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 3v4"></path>
              <path d="M12 17v4"></path>
              <path d="M3 12h4"></path>
              <path d="M17 12h4"></path>
              <path d="m5.6 5.6 2.8 2.8"></path>
              <path d="m15.6 15.6 2.8 2.8"></path>
              <path d="m18.4 5.6-2.8 2.8"></path>
              <path d="m8.4 15.6-2.8 2.8"></path>
            </svg>
            <span data-button-label>Extract support information</span>
          </button>
          <p id="extraction-blocked-note" class="action-note">
            ${extractionBlocked ? escapeHtml(extractionReason) : `Uses ${formatNumber(eligibleSources.length)} fetched source${eligibleSources.length === 1 ? '' : 's'} with stored text. Extracted claims stay pending review.`}
          </p>
        </div>
      </div>

      <div id="research-action-status" class="action-status" role="status" hidden></div>
      <div id="research-action-alert" class="alert alert--error" role="alert" hidden></div>
      <div id="research-run-result">${researchResult ? renderResearchRunResult(researchResult) : ''}</div>
      <div id="extraction-run-result">${extractionResult ? renderExtractionResult(extractionResult, sources) : ''}</div>

      <section class="panel research-section" aria-labelledby="sources-title">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Step 3 · Persisted sources</p>
            <h2 id="sources-title">Discovered source pages</h2>
          </div>
          <span class="status-pill">${formatNumber(sources.length)} recorded</span>
        </div>
        ${renderSourceList(sources, researchResult)}
      </section>

      <section class="panel research-section" aria-labelledby="claims-title">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Step 5 · Evidence workflow</p>
            <h2 id="claims-title">Stored evidence claims</h2>
          </div>
          <span class="status-pill">${formatNumber(evidenceTotal)} total</span>
        </div>
        ${renderStoredEvidence(evidenceItems, evidencePagination)}
      </section>
    `;
  }

  function renderSourceList(sources, researchResult) {
    if (sources.length === 0) {
      return `
        <div class="empty-state empty-state--compact">
          <h3>No sources discovered</h3>
          <p>Run manufacturer research to discover and fetch source pages. No candidate has been recorded for this product yet.</p>
        </div>
      `;
    }

    const latestRunSources = new Map(
      (researchResult && Array.isArray(researchResult.sources) ? researchResult.sources : []).map(
        (source) => [source.id, source],
      ),
    );
    const fetched = sources.filter((source) => source.isFetched);
    const unvisited = sources.filter((source) => !source.isFetched);

    function card(source) {
      const latest = latestRunSources.get(source.id);
      const roles = (source.relationshipTypes || []).map(relationshipLabel).join(' · ');
      const statusClass = source.isExternalCandidate
        ? 'source-card--candidate'
        : source.isFetched
          ? 'source-card--fetched'
          : 'source-card--unvisited';
      const statusLabel = source.isExternalCandidate
        ? 'External candidate · not fetched'
        : source.isFetched
          ? 'Fetched source'
          : 'Not fetched';
      const href = safeHttpUrl(source.url);

      return `
        <article class="source-card ${statusClass}">
          <div class="source-card-head">
            <div>
              <p class="source-role">${escapeHtml(roles)}</p>
              <h3>${
                href
                  ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title || source.domain || 'Untitled source')}</a>`
                  : escapeHtml(source.title || source.domain || 'Untitled source')
              }</h3>
            </div>
            <span class="source-state">${escapeHtml(statusLabel)}</span>
          </div>
          <p class="source-domain"><code>${escapeHtml(source.domain)}</code></p>
          <p class="source-url-line">${sourceLink(source)}</p>
          <dl class="source-meta">
            <div><dt>HTTP</dt><dd>${source.httpStatus === null ? 'Not fetched' : escapeHtml(source.httpStatus)}</dd></div>
            <div><dt>Last fetched</dt><dd>${source.lastFetchedAt ? formatDateTime(source.lastFetchedAt) : 'Never fetched'}</dd></div>
            <div><dt>Latest run</dt><dd>${
              latest
                ? latest.unchanged
                  ? 'Unchanged content'
                  : 'Content changed'
                : 'No run in this session'
            }</dd></div>
          </dl>
          ${
            source.isExternalCandidate
              ? '<p class="source-caveat">Recorded as an external candidate only. This page was never requested and is not evidence.</p>'
              : ''
          }
        </article>
      `;
    }

    return `
      ${
        fetched.length > 0
          ? `<div class="source-group">
               <h3 class="source-group-title">Fetched manufacturer pages <span>${formatNumber(fetched.length)}</span></h3>
               <div class="source-list">${fetched.map(card).join('')}</div>
             </div>`
          : `<div class="alert alert--attention" role="status">
               <p>No manufacturer page has been successfully fetched for this product.</p>
             </div>`
      }
      ${
        unvisited.length > 0
          ? `<div class="source-group">
               <h3 class="source-group-title">Unvisited records <span>${formatNumber(unvisited.length)}</span></h3>
               <p class="source-group-note">These URLs were discovered but not fetched. They must not be treated as researched sources or verified commitments.</p>
               <div class="source-list">${unvisited.map(card).join('')}</div>
             </div>`
          : ''
      }
    `;
  }

  function renderResearchRunResult(result) {
    const failures = Array.isArray(result.failures) ? result.failures : [];
    const review = Array.isArray(result.pagesRequiringReview) ? result.pagesRequiringReview : [];
    const candidates = Array.isArray(result.externalCandidates) ? result.externalCandidates : [];
    const stored = Array.isArray(result.sources) ? result.sources : [];
    const fetched = Number(result.pagesFetched) || 0;
    const attention = failures.length > 0 || fetched === 0;

    const resultTitle =
      fetched === 0
        ? 'Research finished without fetching pages'
        : failures.length > 0
          ? 'Research completed with failures'
          : 'Research completed';

    return `
      <section class="panel run-result ${attention ? 'run-result--attention' : ''}" aria-labelledby="research-run-title">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Server response</p>
            <h3 id="research-run-title">${escapeHtml(resultTitle)}</h3>
            <p class="run-timestamp">Executed ${formatDateTime(result.researchedAt)}</p>
          </div>
          <span class="status-pill ${attention ? 'status-pill--attention' : 'status-pill--good'}">
            ${attention ? 'Review required' : 'Fetched and stored'}
          </span>
        </div>

        <div class="run-stat-grid">
          <div><span>Pages discovered</span><strong>${formatNumber(result.pagesDiscovered)}</strong></div>
          <div><span>Pages fetched</span><strong>${formatNumber(fetched)}</strong></div>
          <div><span>Requiring review</span><strong>${formatNumber(review.length)}</strong></div>
          <div><span>External candidates</span><strong>${formatNumber(candidates.length)}</strong></div>
          <div><span>Failed requests</span><strong>${formatNumber(failures.length)}</strong></div>
          <div><span>Stored sources</span><strong>${formatNumber(stored.length)}</strong></div>
        </div>

        ${
          failures.length > 0
            ? `<div class="run-block">
                 <h4>Failed requests</h4>
                 <ul class="run-list">
                   ${failures
                     .map(
                       (failure) => `<li>
                         <span class="run-list-main"><code>${escapeHtml(failure.url)}</code></span>
                         <span class="run-list-meta">${escapeHtml(failure.reason)}${failure.statusCode ? ` · HTTP ${escapeHtml(failure.statusCode)}` : ''} · ${escapeHtml(failure.message)}</span>
                       </li>`,
                     )
                     .join('')}
                 </ul>
               </div>`
            : ''
        }

        ${
          review.length > 0
            ? `<div class="run-block">
                 <h4>Pages requiring review</h4>
                 <ul class="run-list">
                   ${review
                     .map(
                       (item) => `<li>
                         <span class="run-list-main"><code>${escapeHtml(item.url)}</code></span>
                         <span class="run-list-meta">${escapeHtml(reviewReasonLabel(item.reason))}</span>
                       </li>`,
                     )
                     .join('')}
                 </ul>
               </div>`
            : ''
        }

        ${
          stored.length > 0
            ? `<div class="run-block">
                 <h4>Fetched and stored sources</h4>
                 <ul class="run-list">
                   ${stored
                     .map(
                       (source) => `<li>
                         <span class="run-list-main">${sourceLink(source)}</span>
                         <span class="run-list-meta">${escapeHtml(relationshipLabel(source.relationshipType))} · HTTP ${escapeHtml(source.httpStatus)} · ${source.unchanged ? 'Unchanged content' : 'New or changed content'}</span>
                       </li>`,
                     )
                     .join('')}
                 </ul>
               </div>`
            : ''
        }

        ${
          candidates.length > 0
            ? `<div class="run-block">
                 <h4>External candidates not fetched</h4>
                 <ul class="run-list run-list--candidates">
                   ${candidates
                     .map(
                       (candidate) => `<li>
                         <span class="run-list-main"><code>${escapeHtml(candidate.url)}</code></span>
                         <span class="run-list-meta">External domain${candidate.anchorText ? ` · “${escapeHtml(candidate.anchorText)}”` : ''} · never requested</span>
                       </li>`,
                     )
                     .join('')}
                 </ul>
               </div>`
            : ''
        }

        <p class="run-caveat">A fetched page is a discovered source, not a verified security-support commitment. Support claims are only created in the extraction step and require human review.</p>
      </section>
    `;
  }

  function renderClaimMeta(claim, source) {
    const sourceHtml = source
      ? sourceLink(source)
      : '<span class="value-empty">Source unavailable</span>';

    return `
      <dl class="claim-meta">
        <div><dt>Date text</dt><dd>${claim.dateText ? escapeHtml(claim.dateText) : '<span class="value-empty">Not stated</span>'}</dd></div>
        <div><dt>Date precision</dt><dd>${claim.datePrecision ? escapeHtml(claim.datePrecision) : '<span class="value-empty">Not stated</span>'}</dd></div>
        <div><dt>Normalized date</dt><dd>${claim.normalizedDate ? `<code>${escapeHtml(claim.normalizedDate)}</code>` : '<span class="value-empty">Not available</span>'}</dd></div>
        <div><dt>Source</dt><dd>${sourceHtml}</dd></div>
      </dl>
    `;
  }

  function renderClaimCard(claim, options = {}) {
    const status = options.status || claim.reviewStatus || 'pending';
    const statusLabel =
      status === 'pending' ? 'Pending human review' : status === 'accepted' ? 'Accepted' : 'Rejected';
    return `
      <article class="claim-card">
        <div class="claim-head">
          <span class="claim-type">${escapeHtml(claimTypeLabel(claim.claimType))}</span>
          <span class="status-pill status-pill--${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="claim-content">
          <p class="claim-label">Manufacturer statement</p>
          <p class="claim-statement">${escapeHtml(claim.statement || claim.rawText || '')}</p>
          <p class="claim-label">Supporting quotation</p>
          <blockquote class="claim-quote"><p>${escapeHtml(claim.quotation || claim.quotedExcerpt || '')}</p></blockquote>
          ${renderClaimMeta(claim, options.source || claim.source)}
        </div>
      </article>
    `;
  }

  function renderExtractionResult(result, sources) {
    const storedClaims = Array.isArray(result.storedClaims) ? result.storedClaims : [];
    const rejectedClaims = Array.isArray(result.rejectedClaims) ? result.rejectedClaims : [];
    const duplicates = Array.isArray(result.duplicates) ? result.duplicates : [];
    const skipped = Array.isArray(result.skippedSources) ? result.skippedSources : [];
    const failures = Array.isArray(result.extractionFailures) ? result.extractionFailures : [];
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const attention = storedClaims.length === 0;

    let emptyMessage = '';
    if (storedClaims.length === 0) {
      if ((Number(result.claimsExtracted) || 0) === 0) {
        emptyMessage = 'No relevant support claims were extracted from the processed sources.';
      } else if (rejectedClaims.length > 0) {
        emptyMessage = 'All extracted claims were rejected by validation, so nothing was stored.';
      } else if (duplicates.length > 0) {
        emptyMessage = 'The extracted claims already exist as stored evidence; no duplicate rows were created.';
      } else if (failures.length > 0) {
        emptyMessage = 'No claims could be read from the AI response. Review the extraction failures below.';
      } else {
        emptyMessage = 'No claims were stored in this run.';
      }
    }

    return `
      <section class="panel run-result ${attention ? 'run-result--attention' : ''}" aria-labelledby="extraction-run-title">
        <div class="panel-head">
          <div>
            <p class="eyebrow">AI extraction response</p>
            <h3 id="extraction-run-title">${storedClaims.length > 0 ? 'Extraction completed' : 'Extraction finished without stored claims'}</h3>
            <p class="run-timestamp">Executed ${formatDateTime(result.extractedAt)}</p>
          </div>
          <span class="status-pill ${storedClaims.length > 0 ? 'status-pill--pending' : 'status-pill--attention'}">
            ${storedClaims.length > 0 ? 'Pending human review' : 'No claims stored'}
          </span>
        </div>

        <div class="run-stat-grid">
          <div><span>Sources processed</span><strong>${formatNumber(result.sourcesProcessed)}</strong></div>
          <div><span>Sources skipped</span><strong>${formatNumber(result.sourcesSkipped)}</strong></div>
          <div><span>Claims extracted</span><strong>${formatNumber(result.claimsExtracted)}</strong></div>
          <div><span>Claims stored</span><strong>${formatNumber(result.claimsStored)}</strong></div>
          <div><span>Claims rejected</span><strong>${formatNumber(result.claimsRejected)}</strong></div>
          <div><span>Duplicate claims</span><strong>${formatNumber(result.duplicateClaims)}</strong></div>
        </div>

        ${emptyMessage ? `<div class="empty-state empty-state--compact"><p>${escapeHtml(emptyMessage)}</p></div>` : ''}

        ${
          storedClaims.length > 0
            ? `<div class="claim-list">
                 ${storedClaims
                   .map((claim) =>
                     renderClaimCard(
                       { ...claim, rawText: claim.statement },
                       {
                         status: 'pending',
                         source: sourceById.get(claim.sourceId),
                       },
                     ),
                   )
                   .join('')}
               </div>`
            : ''
        }

        ${
          rejectedClaims.length > 0
            ? `<div class="run-block">
                 <h4>Claims rejected by validation</h4>
                 <ul class="run-list">
                   ${rejectedClaims
                     .map(
                       (claim) => `<li>
                         <span class="run-list-main">${escapeHtml(claimTypeLabel(claim.claimType))}: ${escapeHtml(claim.statement)}</span>
                         <span class="run-list-meta">${escapeHtml(claim.reason)} · ${escapeHtml(claim.message)}</span>
                       </li>`,
                     )
                     .join('')}
                 </ul>
               </div>`
            : ''
        }

        ${
          duplicates.length > 0
            ? `<div class="run-block">
                 <h4>Duplicate claims</h4>
                 <ul class="run-list">
                   ${duplicates
                     .map(
                       (claim) => `<li>
                         <span class="run-list-main">${escapeHtml(claimTypeLabel(claim.claimType))}</span>
                         <span class="run-list-meta">Already stored from source ${escapeHtml(claim.sourceId)}</span>
                       </li>`,
                     )
                     .join('')}
                 </ul>
               </div>`
            : ''
        }

        ${
          skipped.length > 0
            ? `<div class="run-block">
                 <h4>Sources skipped</h4>
                 <ul class="run-list">
                   ${skipped
                     .map(
                       (source) => `<li>
                         <span class="run-list-main"><code>${escapeHtml(source.url)}</code></span>
                         <span class="run-list-meta">${escapeHtml(extractionSkipLabel(source.reason))}</span>
                       </li>`,
                     )
                     .join('')}
                 </ul>
               </div>`
            : ''
        }

        ${
          failures.length > 0
            ? `<div class="run-block">
                 <h4>Extraction failures</h4>
                 <ul class="run-list">
                   ${failures
                     .map(
                       (failure) => `<li>
                         <span class="run-list-main"><code>${escapeHtml(failure.url)}</code></span>
                         <span class="run-list-meta">${escapeHtml(failure.reason)} · ${escapeHtml(failure.message)}</span>
                       </li>`,
                     )
                     .join('')}
                 </ul>
               </div>`
            : ''
        }

        <p class="run-caveat">Extracted claims are not accepted support commitments. Validation only confirms that a quotation exists in stored source text; a human review decision is still required.</p>
      </section>
    `;
  }

  function renderStoredEvidence(items, pagination) {
    const total = Number(pagination.total) || items.length;

    if (items.length === 0) {
      return `
        <div class="empty-state empty-state--compact">
          <h3>No evidence claims stored</h3>
          <p>Extract support information from a fetched source, or revisit this product later to inspect persisted claims.</p>
        </div>
      `;
    }

    return `
      <div class="claim-list">
        ${items.map((item) => renderClaimCard(item, { status: item.reviewStatus, source: item.source })).join('')}
      </div>
      <p class="panel-note claims-note">
        Showing ${formatNumber(items.length)} of ${formatNumber(total)} stored claim${total === 1 ? '' : 's'}, newest first. No accept or reject action is available in this research workspace.
      </p>
    `;
  }

  function wireResearchWorkspace(product, sources, renderSeq) {
    const researchButton = document.getElementById('research-button');
    const extractButton = document.getElementById('extract-button');

    if (researchButton) {
      researchButton.addEventListener('click', () => {
        runResearch(product, sources, renderSeq);
      });
    }

    if (extractButton) {
      extractButton.addEventListener('click', () => {
        runExtraction(product, sources, renderSeq);
      });
    }
  }

  function setResearchOperationBusy(kind, busy) {
    const researchButton = document.getElementById('research-button');
    const extractButton = document.getElementById('extract-button');
    const status = document.getElementById('research-action-status');
    const workspace = document.getElementById('research-workspace');

    [researchButton, extractButton].forEach((button) => {
      if (!button) return;
      button.disabled = busy || button.getAttribute('data-base-disabled') === 'true';
      if (busy) button.setAttribute('aria-busy', 'true');
      else button.removeAttribute('aria-busy');
    });

    if (researchButton) {
      const label = researchButton.querySelector('[data-button-label]');
      if (label) {
        label.textContent =
          busy && kind === 'research' ? 'Researching manufacturer…' : 'Research manufacturer';
      }
    }
    if (extractButton) {
      const label = extractButton.querySelector('[data-button-label]');
      if (label) {
        label.textContent =
          busy && kind === 'extraction'
            ? 'Extracting support information…'
            : 'Extract support information';
      }
    }

    if (workspace) {
      if (busy) workspace.setAttribute('aria-busy', 'true');
      else workspace.removeAttribute('aria-busy');
    }

    if (status) {
      if (busy) {
        status.hidden = false;
        status.textContent =
          kind === 'research'
            ? 'Request sent. The server is fetching manufacturer pages synchronously; this may take a while. No progress is simulated.'
            : 'Request sent. The server is asking the configured AI provider and validating each quotation. No claims are accepted automatically.';
      } else {
        status.hidden = true;
        status.textContent = '';
      }
    }
  }

  function showResearchActionError(message) {
    const alertBox = document.getElementById('research-action-alert');
    if (!alertBox) return;
    alertBox.textContent = message;
    alertBox.hidden = false;
    alertBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function researchActionError(error, operation) {
    if (error instanceof ApiError) {
      switch (error.code) {
        case 'MANUFACTURER_WEBSITE_MISSING':
          return 'Research cannot start because this manufacturer has no registered website.';
        case 'UNSAFE_MANUFACTURER_WEBSITE':
          return error.message || 'The manufacturer website cannot be researched safely.';
        case 'PRODUCT_NOT_FOUND':
          return 'This product no longer exists in the catalogue.';
        case 'AI_NOT_CONFIGURED':
          return 'AI extraction is not configured on this server. Set AI_BASE_URL, AI_API_KEY and AI_MODEL, then restart the service.';
        case 'AI_PROVIDER_TIMEOUT':
          return 'The AI provider did not respond before the configured timeout. No new claims were stored.';
        case 'AI_PROVIDER_ERROR':
          return 'The AI provider request failed. No new claims were stored; try again when the provider is available.';
        case 'AI_INPUT_TOO_LARGE':
          return 'The stored source text is too large for the configured AI input limit.';
        default:
          return error.message || `The ${operation} request failed.`;
      }
    }
    return error instanceof Error ? error.message : `The ${operation} request failed.`;
  }

  async function runResearch(product, sources, renderSeq) {
    if (state.researchBusy) return;
    state.researchBusy = true;

    const alertBox = document.getElementById('research-action-alert');
    if (alertBox) {
      alertBox.hidden = true;
      alertBox.textContent = '';
    }
    setResearchOperationBusy('research', true);

    try {
      const body = await api(`/api/v1/products/${encodeURIComponent(product.id)}/research`, {
        method: 'POST',
      });
      if (renderSeq !== state.renderSeq) return;

      const result = body && body.data ? body.data : null;
      if (!result || result.productId !== product.id) {
        throw new ApiError('The server did not return a research result for this product.', 500, 'INVALID_RESPONSE');
      }

      state.researchResult = { productId: product.id, data: result };
      state.extractionResult = null;
      const query = parseResearchQuery();
      await Promise.all([
        loadResearchWorkspace(renderSeq, product.id, { focusResult: true }),
        loadResearchProducts(renderSeq, query.page, query.manufacturerId, product.id),
      ]);
    } catch (error) {
      if (renderSeq !== state.renderSeq) return;
      if (error instanceof ApiError && error.status === 401) return;
      showResearchActionError(researchActionError(error, 'research'));
      setResearchOperationBusy('research', false);
    } finally {
      state.researchBusy = false;
      if (renderSeq === state.renderSeq) {
        setResearchOperationBusy('research', false);
      }
    }
  }

  async function runExtraction(product, sources, renderSeq) {
    if (state.researchBusy) return;
    const eligible = sources.filter(
      (source) => source.isFetched && source.hasContent && !source.isExternalCandidate,
    );
    if (eligible.length === 0) return;

    state.researchBusy = true;
    const alertBox = document.getElementById('research-action-alert');
    if (alertBox) {
      alertBox.hidden = true;
      alertBox.textContent = '';
    }
    setResearchOperationBusy('extraction', true);

    try {
      const body = await api(`/api/v1/products/${encodeURIComponent(product.id)}/extract-evidence`, {
        method: 'POST',
      });
      if (renderSeq !== state.renderSeq) return;

      const result = body && body.data ? body.data : null;
      if (!result || result.productId !== product.id) {
        throw new ApiError('The server did not return an extraction result for this product.', 500, 'INVALID_RESPONSE');
      }

      state.extractionResult = { productId: product.id, data: result };
      const query = parseResearchQuery();
      await Promise.all([
        loadResearchWorkspace(renderSeq, product.id, { focusResult: true }),
        loadResearchProducts(renderSeq, query.page, query.manufacturerId, product.id),
      ]);
    } catch (error) {
      if (renderSeq !== state.renderSeq) return;
      if (error instanceof ApiError && error.status === 401) return;
      showResearchActionError(researchActionError(error, 'extraction'));
      setResearchOperationBusy('extraction', false);
    } finally {
      state.researchBusy = false;
      if (renderSeq === state.renderSeq) {
        setResearchOperationBusy('extraction', false);
      }
    }
  }

  const REVIEW_STATUSES = ['pending', 'accepted', 'rejected', 'conflicting', 'all'];

  function reviewStatusLabel(status) {
    switch (status) {
      case 'pending':
        return 'Pending review';
      case 'accepted':
        return 'Accepted';
      case 'rejected':
        return 'Rejected';
      case 'conflicting':
        return 'Conflicting evidence';
      default:
        return 'All evidence';
    }
  }

  function reviewStatusClass(status) {
    switch (status) {
      case 'accepted':
        return 'status-pill--accepted';
      case 'rejected':
        return 'status-pill--rejected';
      case 'pending':
        return 'status-pill--pending';
      default:
        return '';
    }
  }

  function parseReviewQuery() {
    const params = new URLSearchParams(window.location.search);
    const pageValue = Number(params.get('page'));
    const status = params.get('status') || 'pending';
    return {
      page: Number.isInteger(pageValue) && pageValue > 0 ? pageValue : 1,
      status: REVIEW_STATUSES.includes(status) ? status : 'pending',
      search: (params.get('q') || '').trim(),
      evidenceId: params.get('evidenceId') || '',
    };
  }

  function reviewPath(page, status, search, evidenceId) {
    const params = new URLSearchParams();
    if (page > 1) params.set('page', String(page));
    if (status && status !== 'pending') params.set('status', status);
    if (search) params.set('q', search);
    if (evidenceId) params.set('evidenceId', evidenceId);
    const query = params.toString();
    return `/dashboard/review${query ? `?${query}` : ''}`;
  }

  function reviewReadiness(assessment) {
    const summary = assessment.summary || {};
    const accepted = Number(summary.accepted) || 0;
    const pending = Number(summary.pendingReview) || 0;
    const rejected = Number(summary.rejected) || 0;
    const conflictOnAccepted = (assessment.detectedConflicts || []).some((group) =>
      (group.evidence || []).some((item) => item.reviewStatus === 'accepted'),
    );

    let label = 'Insufficient information';
    let tone = '';
    let detail = 'No accepted evidence is available for public support information.';

    if (conflictOnAccepted) {
      label = 'Conflicting information';
      tone = 'status-pill--attention';
      detail = 'Accepted evidence is involved in a conflict, so public support information withholds the commitment.';
    } else if (accepted > 0) {
      label = 'Ready for public information';
      tone = 'status-pill--good';
      detail = 'At least one accepted claim exists without an accepted-evidence conflict.';
    } else if (pending > 0) {
      label = 'Awaiting review';
      tone = 'status-pill--pending';
      detail = 'Pending evidence must be reviewed before public support information is available.';
    } else if (rejected > 0) {
      label = 'Rejected evidence only';
      tone = 'status-pill--attention';
      detail = 'Every stored claim for this product has been rejected.';
    }

    return {
      label,
      tone,
      detail,
      accepted,
      pending,
      rejected,
      conflictOnAccepted,
      ready: accepted > 0 && !conflictOnAccepted,
    };
  }

  function renderReview(target, renderSeq) {
    const query = parseReviewQuery();
    if (state.reviewOutcome && state.reviewOutcome.evidenceId !== query.evidenceId) {
      state.reviewOutcome = null;
    }

    target.innerHTML = `
      <section class="page" aria-labelledby="review-title">
        ${pageHeading(
          'Evidence review',
          'Evidence review',
          'Inspect extracted claims and their original quotations, compare conflicting manufacturer statements, and record a human decision. The queue is read from PostgreSQL; assessment and conflict results come from the backend.',
          `<a class="button button--secondary" href="/dashboard/research" data-link>Research workbench</a>`,
        )}

        <div class="review-intro">
          <p>
            A quotation being present in a source is not proof that a product is secure. Accepting
            evidence records a reviewed manufacturer statement; it is not security certification or
            CRA compliance.
          </p>
        </div>

        <section class="panel review-queue-panel" aria-labelledby="review-queue-title">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Review queue</p>
              <h2 id="review-queue-title">Evidence requiring attention</h2>
            </div>
            <span id="review-queue-total" class="status-pill">Loading…</span>
          </div>

          <form id="review-filters" class="review-filters">
            <div class="field">
              <label for="review-status">Status</label>
              <select id="review-status" name="status">
                <option value="pending"${query.status === 'pending' ? ' selected' : ''}>Pending review</option>
                <option value="accepted"${query.status === 'accepted' ? ' selected' : ''}>Accepted</option>
                <option value="rejected"${query.status === 'rejected' ? ' selected' : ''}>Rejected</option>
                <option value="conflicting"${query.status === 'conflicting' ? ' selected' : ''}>Conflicting evidence</option>
                <option value="all"${query.status === 'all' ? ' selected' : ''}>All evidence</option>
              </select>
            </div>
            <div class="field review-search-field">
              <label for="review-search">Search</label>
              <input
                id="review-search"
                name="q"
                type="search"
                maxlength="100"
                value="${escapeHtml(query.search)}"
                placeholder="Product, manufacturer, model or GTIN"
              />
            </div>
            <div class="review-filter-actions">
              <button class="button button--primary" type="submit">Apply filters</button>
              <a class="button button--quiet" href="/dashboard/review" data-link>Clear</a>
            </div>
          </form>

          <div class="review-counts" aria-live="polite">
            <span>All evidence <strong id="review-count-all">—</strong></span>
            <span>Pending <strong id="review-count-pending">—</strong></span>
            <span>Accepted <strong id="review-count-accepted">—</strong></span>
            <span>Rejected <strong id="review-count-rejected">—</strong></span>
            <span>Conflicting <strong id="review-count-conflicting">—</strong></span>
          </div>

          <div id="review-queue">
            ${loadingBlock('Loading evidence records and review counts…')}
          </div>
        </section>

        <section id="review-detail" class="review-detail" aria-label="Evidence detail and review">
          <div class="empty-state">
            <p class="empty-kicker">No evidence selected</p>
            <h2>Select an evidence record</h2>
            <p>Open a claim from the queue to inspect its quotation, source, assessment and conflict position.</p>
          </div>
        </section>
      </section>
    `;

    const form = document.getElementById('review-filters');
    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const status = document.getElementById('review-status')?.value || 'pending';
        const search = (document.getElementById('review-search')?.value || '').trim();
        navigate(reviewPath(1, status, search, ''));
      });
    }

    focusHeading();
    loadReviewQueue(renderSeq, query);
    if (query.evidenceId) {
      loadReviewDetail(renderSeq, query.evidenceId);
    } else {
      state.reviewDetailSeq += 1;
    }
  }

  function updateReviewCounts(counts) {
    const values = {
      all: counts.all,
      pending: counts.pending,
      accepted: counts.accepted,
      rejected: counts.rejected,
      conflicting: counts.conflicting,
    };

    for (const [key, value] of Object.entries(values)) {
      const target = document.getElementById(`review-count-${key}`);
      if (target) target.textContent = formatNumber(value);
    }

    const select = document.getElementById('review-status');
    if (select) {
      select.querySelectorAll('option').forEach((option) => {
        const key = option.value;
        const count = values[key];
        option.textContent = `${reviewStatusLabel(key)} (${formatNumber(count)})`;
      });
    }
  }

  async function loadReviewQueue(renderSeq, query) {
    const requestSeq = ++state.reviewQueueSeq;
    const params = new URLSearchParams({
      page: String(query.page),
      pageSize: '20',
      reviewStatus: query.status,
    });
    if (query.search) params.set('search', query.search);

    try {
      const body = await api(`/api/v1/dashboard/evidence-queue?${params.toString()}`);
      if (requestSeq !== state.reviewQueueSeq || renderSeq !== state.renderSeq) return;

      const items = Array.isArray(body?.data) ? body.data : null;
      const pagination = body?.pagination;
      const counts = body?.counts;
      if (
        !items ||
        !pagination ||
        typeof pagination.total !== 'number' ||
        !counts ||
        typeof counts.pending !== 'number'
      ) {
        throw new ApiError('The server returned an unexpected evidence queue response.', 500, 'INVALID_RESPONSE');
      }

      updateReviewCounts(counts);

      const totalLabel = document.getElementById('review-queue-total');
      if (totalLabel) {
        totalLabel.textContent = `${formatNumber(pagination.total)} record${pagination.total === 1 ? '' : 's'}`;
      }

      const container = document.getElementById('review-queue');
      if (!container) return;

      const totalPages = Number(pagination.totalPages) || 0;
      const rows = items
        .map((item) => {
          const sourceDomain = item.source?.domain || 'Source unavailable';
          return `
            <tr class="${item.id === query.evidenceId ? 'is-selected' : ''}">
              <td data-label="Product">
                <button class="product-link" type="button" data-select-evidence="${escapeHtml(item.id)}">
                  ${escapeHtml(item.product.name)}
                </button>
                <span class="cell-sub">${escapeHtml(item.product.category || 'Category not recorded')}</span>
              </td>
              <td data-label="Manufacturer">${escapeHtml(item.manufacturer.name)}</td>
              <td data-label="Model"><code>${valueOrDash(item.product.modelIdentifier)}</code></td>
              <td data-label="Claim">${escapeHtml(claimTypeLabel(item.claimType))}</td>
              <td data-label="Statement">
                <span class="queue-statement" title="${escapeHtml(item.statement)}">${escapeHtml(item.statement)}</span>
              </td>
              <td data-label="Date">${
                item.dateText
                  ? `${escapeHtml(item.dateText)}<span class="cell-sub">${escapeHtml(item.datePrecision || 'Precision unavailable')}</span>`
                  : '<span class="value-empty">No date</span>'
              }</td>
              <td data-label="Source"><code class="queue-domain">${escapeHtml(sourceDomain)}</code></td>
              <td data-label="Extracted"><time datetime="${escapeHtml(item.extractionTimestamp)}">${formatDateTime(item.extractionTimestamp)}</time></td>
              <td data-label="Status">
                <span class="status-pill ${reviewStatusClass(item.status)}">${escapeHtml(reviewStatusLabel(item.status))}</span>
                ${item.conflicting ? '<span class="review-conflict-flag">Conflict</span>' : ''}
              </td>
            </tr>
          `;
        })
        .join('');

      const paginationControls =
        totalPages > 0
          ? `<nav class="pagination" aria-label="Evidence review pages">
               ${
                 query.page > 1
                   ? `<a class="button button--quiet" href="${reviewPath(query.page - 1, query.status, query.search, '')}" data-link rel="prev">Previous</a>`
                   : '<span class="button button--quiet is-disabled" aria-disabled="true">Previous</span>'
               }
               <span class="pagination-status">Page ${formatNumber(query.page)} of ${formatNumber(totalPages)}</span>
               ${
                 query.page < totalPages
                   ? `<a class="button button--quiet" href="${reviewPath(query.page + 1, query.status, query.search, '')}" data-link rel="next">Next</a>`
                   : '<span class="button button--quiet is-disabled" aria-disabled="true">Next</span>'
               }
             </nav>`
          : '';

      container.innerHTML = `
        ${
          items.length === 0
            ? `<div class="empty-state empty-state--compact">
                 <p class="empty-kicker">Queue empty</p>
                 <h3>${query.search ? 'No evidence matches this search' : query.status === 'pending' ? 'No evidence awaiting review' : 'No evidence in this filter'}</h3>
                 <p>${query.search ? 'Try a different product, manufacturer, model or GTIN.' : query.status === 'pending' ? 'Newly extracted support claims will appear here for human review.' : 'Choose another status to inspect other review records.'}</p>
                 <div class="form-actions">
                   ${query.status === 'pending' && !query.search ? '<a class="button button--primary" href="/dashboard/research" data-link>Open research workbench</a>' : '<a class="button button--secondary" href="/dashboard/review" data-link>Reset filters</a>'}
                 </div>
               </div>`
            : `<div class="table-wrap review-queue-table">
                 <table class="data-table data-table--review-queue">
                   <caption class="visually-hidden">Evidence review queue</caption>
                   <thead>
                     <tr>
                       <th scope="col">Product</th>
                       <th scope="col">Manufacturer</th>
                       <th scope="col">Model</th>
                       <th scope="col">Claim</th>
                       <th scope="col">Statement</th>
                       <th scope="col">Date</th>
                       <th scope="col">Source</th>
                       <th scope="col">Extracted</th>
                       <th scope="col">Status</th>
                     </tr>
                   </thead>
                   <tbody>${rows}</tbody>
                 </table>
               </div>
               ${paginationControls}`
        }
      `;

      container.querySelectorAll('[data-select-evidence]').forEach((button) => {
        button.addEventListener('click', () => {
          navigate(
            reviewPath(
              query.page,
              query.status,
              query.search,
              button.getAttribute('data-select-evidence'),
            ),
          );
        });
      });
    } catch (error) {
      if (requestSeq !== state.reviewQueueSeq || renderSeq !== state.renderSeq) return;
      if (error instanceof ApiError && error.status === 401) return;

      const container = document.getElementById('review-queue');
      if (!container) return;
      container.innerHTML = `
        <div class="alert alert--error" role="alert">
          <p>${escapeHtml(error.message || 'The evidence review queue could not be loaded.')}</p>
        </div>
        <div class="form-actions">
          <button class="button button--secondary" type="button" data-retry-review-queue>Try again</button>
        </div>
      `;
      const retry = container.querySelector('[data-retry-review-queue]');
      if (retry) {
        retry.addEventListener('click', () => {
          container.innerHTML = loadingBlock('Reloading evidence records…');
          loadReviewQueue(renderSeq, query);
        });
      }
    }
  }

  async function loadReviewDetail(renderSeq, evidenceId, options = {}) {
    const requestSeq = ++state.reviewDetailSeq;
    const container = document.getElementById('review-detail');
    if (!container) return;

    state.reviewDecision = null;
    container.innerHTML = loadingBlock('Loading the evidence record, source and assessment…');

    try {
      const evidenceBody = await api(`/api/v1/evidence/${encodeURIComponent(evidenceId)}`);
      const evidence = evidenceBody?.data;
      if (!evidence || !evidence.id || !evidence.productId) {
        throw new ApiError('The server returned an unexpected evidence response.', 500, 'INVALID_RESPONSE');
      }

      const [productBody, assessmentBody] = await Promise.all([
        api(`/api/v1/products/${encodeURIComponent(evidence.productId)}`),
        api(`/api/v1/products/${encodeURIComponent(evidence.productId)}/evidence/assessment`),
      ]);

      if (requestSeq !== state.reviewDetailSeq || renderSeq !== state.renderSeq) return;

      const product = productBody?.data;
      const assessment = assessmentBody?.data;
      if (
        !product ||
        !product.id ||
        !assessment ||
        !Array.isArray(assessment.items) ||
        !Array.isArray(assessment.detectedConflicts) ||
        !Array.isArray(assessment.claimsRequiringManualReview)
      ) {
        throw new ApiError('The server returned an unexpected assessment response.', 500, 'INVALID_RESPONSE');
      }

      const assessmentItem = assessment.items.find((item) => item.evidenceId === evidence.id) || null;
      container.innerHTML = renderReviewDetail(
        evidence,
        product,
        assessment,
        assessmentItem,
      );
      wireReviewDetail(evidence, product, assessment, assessmentItem, renderSeq);

      if (options.focusResult) {
        const heading = container.querySelector('#review-detail-title');
        if (heading) {
          heading.setAttribute('tabindex', '-1');
          heading.focus({ preventScroll: true });
          heading.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
      }
    } catch (error) {
      if (requestSeq !== state.reviewDetailSeq || renderSeq !== state.renderSeq) return;
      if (error instanceof ApiError && error.status === 401) return;

      const code = error instanceof ApiError ? error.code : null;
      const message =
        code === 'EVIDENCE_NOT_FOUND'
          ? 'That evidence record no longer exists.'
          : code === 'PRODUCT_NOT_FOUND'
            ? 'The product linked to this evidence record was not found.'
            : error.message || 'The evidence detail could not be loaded.';

      container.innerHTML = `
        <div class="panel">
          <div class="alert alert--error" role="alert"><p>${escapeHtml(message)}</p></div>
          <div class="form-actions">
            <button class="button button--secondary" type="button" data-retry-review-detail>Try again</button>
            <a class="button button--quiet" href="${reviewPath(1, 'pending', '', '')}" data-link>Back to pending queue</a>
          </div>
        </div>
      `;
      const retry = container.querySelector('[data-retry-review-detail]');
      if (retry) retry.addEventListener('click', () => loadReviewDetail(renderSeq, evidenceId));
    }
  }

  function integrityCheckHtml(title, check) {
    const valid = Boolean(check && check.valid);
    const reasons = Array.isArray(check?.reasons) ? check.reasons : [];
    return `
      <div class="integrity-card ${valid ? 'integrity-card--pass' : 'integrity-card--fail'}">
        <div class="integrity-head">
          <span>${escapeHtml(title)}</span>
          <strong>${valid ? 'Passed' : 'Failed'}</strong>
        </div>
        ${
          reasons.length > 0
            ? `<ul class="integrity-reasons">${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`
            : `<p class="integrity-clean">${valid ? 'No failures reported.' : 'The assessment returned no additional detail.'}</p>`
        }
      </div>
    `;
  }

  function domainAssociationHtml(item) {
    if (!item || !item.source) {
      return `
        <div class="integrity-card integrity-card--fail">
          <div class="integrity-head"><span>Domain association</span><strong>Not assessable</strong></div>
          <p class="integrity-clean">No source record is available for this claim.</p>
        </div>
      `;
    }

    const domainFailure = (item.sourceIntegrity?.reasons || []).find((reason) =>
      reason.startsWith('Source domain ('),
    );
    return `
      <div class="integrity-card ${domainFailure ? 'integrity-card--fail' : 'integrity-card--pass'}">
        <div class="integrity-head">
          <span>Domain association</span>
          <strong>${domainFailure ? 'Failed' : 'Passed'}</strong>
        </div>
        <p class="integrity-clean">${
          domainFailure
            ? escapeHtml(domainFailure)
            : `Stored source domain ${escapeHtml(item.source.domain)} passed the backend manufacturer-domain check.`
        }</p>
      </div>
    `;
  }

  function renderConflictGroups(assessment, assessmentItem, selectedEvidenceId) {
    const conflicts = assessment.detectedConflicts || [];
    const manual = assessment.claimsRequiringManualReview || [];
    const itemMap = new Map((assessment.items || []).map((item) => [item.evidenceId, item]));

    const conflictHtml = conflicts
      .map((group, groupIndex) => {
        const cards = (group.evidence || [])
          .map((item, index) => {
            const fullItem = itemMap.get(item.evidenceId);
            const source = fullItem?.source || null;
            const url = safeHttpUrl(item.sourceUrl || source?.url);
            return `
              <article class="conflict-claim ${item.evidenceId === selectedEvidenceId ? 'is-selected' : ''}">
                <div class="conflict-claim-head">
                  <span class="conflict-source-label">Source ${String.fromCharCode(65 + index)}</span>
                  <span class="status-pill ${reviewStatusClass(item.reviewStatus)}">${escapeHtml(reviewStatusLabel(item.reviewStatus))}</span>
                </div>
                <p class="conflict-source-title">${escapeHtml(source?.title || source?.domain || 'Source unavailable')}</p>
                <p class="claim-label">Manufacturer states</p>
                <p class="conflict-statement">“${escapeHtml(item.rawText)}”</p>
                <p class="claim-label">Supporting quotation</p>
                <blockquote class="claim-quote claim-quote--compact"><p>${escapeHtml(item.quotedExcerpt)}</p></blockquote>
                <dl class="conflict-meta">
                  <div><dt>Date text</dt><dd>${item.dateText ? escapeHtml(item.dateText) : '<span class="value-empty">Not stated</span>'}</dd></div>
                  <div><dt>Precision</dt><dd>${item.datePrecision ? escapeHtml(item.datePrecision) : '<span class="value-empty">Not stated</span>'}</dd></div>
                  <div><dt>Normalized</dt><dd>${item.normalizedDate ? `<code>${escapeHtml(item.normalizedDate)}</code>` : '<span class="value-empty">Not available</span>'}</dd></div>
                </dl>
                <div class="conflict-claim-actions">
                  ${
                    url
                      ? `<a class="text-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open source</a>`
                      : '<span class="value-empty">Source URL unavailable</span>'
                  }
                  <button class="button button--quiet" type="button" data-inspect-conflict="${escapeHtml(item.evidenceId)}">Inspect claim</button>
                </div>
              </article>
            `;
          })
          .join('');

        const acceptedInGroup = (group.evidence || []).some(
          (item) => item.reviewStatus === 'accepted',
        );

        return `
          <article class="conflict-group" aria-labelledby="conflict-title-${groupIndex}">
            <div class="conflict-head">
              <div>
                <p class="eyebrow">Conflict ${groupIndex + 1}</p>
                <h4 id="conflict-title-${groupIndex}">${escapeHtml(claimTypeLabel(group.claimType))}</h4>
              </div>
              <span class="status-pill status-pill--attention">Conflict detected</span>
            </div>
            <p class="conflict-explanation">${escapeHtml(group.conflictExplanation)}</p>
            ${acceptedInGroup ? '<div class="alert alert--attention"><p>An accepted claim is part of this conflict. The backend withholds public support information while an accepted commitment is contested.</p></div>' : ''}
            <div class="conflict-grid">${cards}</div>
            <p class="conflict-result">Conflicting manufacturer commitments require investigation. No claim has been selected automatically; review each source and make an explicit decision.</p>
          </article>
        `;
      })
      .join('');

    const manualHtml = manual
      .map(
        (item) => `
          <li>
            <div>
              <strong>${escapeHtml(claimTypeLabel(item.claimType))}</strong>
              <p>${escapeHtml(item.reason)}</p>
            </div>
            <button class="button button--quiet" type="button" data-inspect-conflict="${escapeHtml(item.evidenceId)}">Inspect</button>
          </li>
        `,
      )
      .join('');

    if (conflicts.length === 0 && manual.length === 0) {
      return `
        <div class="empty-state empty-state--compact">
          <h3>No conflicts or ambiguous comparisons detected</h3>
          <p>The backend assessment found no competing date commitments for this product.</p>
        </div>
      `;
    }

    return `
      ${conflictHtml}
      ${
        manual.length > 0
          ? `<div class="manual-review-block">
               <div class="panel-head">
                 <div>
                   <p class="eyebrow">Ambiguous comparison</p>
                   <h4>Requires further review</h4>
                 </div>
                 <span class="status-pill">${formatNumber(new Set(manual.map((item) => item.evidenceId)).size)} claim${new Set(manual.map((item) => item.evidenceId)).size === 1 ? '' : 's'}</span>
               </div>
               <p class="panel-note">These records are not labelled as confirmed conflicts. The backend could not safely compare their date wording or precision.</p>
               <ul class="manual-review-list">${manualHtml}</ul>
             </div>`
          : ''
      }
    `;
  }

  function renderReviewHistory(reviews) {
    if (!Array.isArray(reviews) || reviews.length === 0) {
      return `
        <div class="empty-state empty-state--compact">
          <h3>No review history</h3>
          <p>This evidence record has not received a human decision yet.</p>
        </div>
      `;
    }

    return `
      <ol class="review-history">
        ${reviews
          .map(
            (review) => `
              <li>
                <div class="review-history-head">
                  <span class="status-pill ${reviewStatusClass(review.decision)}">${escapeHtml(reviewStatusLabel(review.decision))}</span>
                  <time datetime="${escapeHtml(review.createdAt)}">${formatDateTime(review.createdAt)}</time>
                </div>
                <p class="review-history-transition">Previous status: <strong>${escapeHtml(reviewStatusLabel(review.previousStatus))}</strong></p>
                <p class="review-history-note">${escapeHtml(review.reviewNote)}</p>
              </li>
            `,
          )
          .join('')}
      </ol>
    `;
  }

  function renderReviewDetail(evidence, product, assessment, assessmentItem) {
    const manufacturer = product.manufacturer || {};
    const source = evidence.source || assessmentItem?.source || null;
    const sourceUrl = safeHttpUrl(source?.url);
    const readiness = reviewReadiness(assessment);
    const outcome =
      state.reviewOutcome && state.reviewOutcome.evidenceId === evidence.id
        ? state.reviewOutcome
        : null;
    const conflictOnPendingOnly =
      !readiness.conflictOnAccepted && (assessment.detectedConflicts || []).length > 0;

    return `
      <div class="review-detail-head">
        <div>
          <p class="eyebrow">Evidence detail</p>
          <h2 id="review-detail-title">${escapeHtml(product.name)}</h2>
          <p class="workspace-subtitle">
            ${escapeHtml(manufacturer.name || 'Manufacturer not recorded')}
            ${product.modelIdentifier ? ` · <code>${escapeHtml(product.modelIdentifier)}</code>` : ''}
            ${product.category ? ` · ${escapeHtml(product.category)}` : ''}
          </p>
        </div>
        <div class="review-readiness">
          <span class="status-pill ${readiness.tone}">${escapeHtml(readiness.label)}</span>
          <small>${escapeHtml(readiness.detail)}</small>
        </div>
      </div>

      ${
        outcome
          ? `<div class="alert alert--success" role="status">
               <p>Review recorded. This evidence is now <strong>${escapeHtml(reviewStatusLabel(outcome.status))}</strong> as of ${formatDateTime(outcome.recordedAt)}.</p>
             </div>`
          : ''
      }

      <div class="review-claim-layout">
        <section class="panel" aria-labelledby="review-claim-title">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Extracted claim</p>
              <h3 id="review-claim-title">${escapeHtml(claimTypeLabel(evidence.claimType))}</h3>
            </div>
            <span class="status-pill ${reviewStatusClass(evidence.reviewStatus)}">${escapeHtml(reviewStatusLabel(evidence.reviewStatus))}</span>
          </div>
          <p class="claim-label">Original extracted statement</p>
          <p class="review-statement">${escapeHtml(evidence.rawText)}</p>
          <dl class="review-facts">
            <div><dt>Date text</dt><dd>${evidence.dateText ? escapeHtml(evidence.dateText) : '<span class="value-empty">Not stated</span>'}</dd></div>
            <div><dt>Date precision</dt><dd>${evidence.datePrecision ? escapeHtml(evidence.datePrecision) : '<span class="value-empty">Not stated</span>'}</dd></div>
            <div><dt>Normalized date</dt><dd>${evidence.normalizedDate ? `<code>${escapeHtml(evidence.normalizedDate)}</code>` : '<span class="value-empty">Not available</span>'}</dd></div>
            <div><dt>Extracted</dt><dd>${formatDateTime(evidence.createdAt)}</dd></div>
          </dl>
        </section>

        <section class="panel review-quote-panel" aria-labelledby="review-quote-title">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Supporting manufacturer evidence</p>
              <h3 id="review-quote-title">Exact quotation</h3>
            </div>
          </div>
          <blockquote class="review-quote"><p>${escapeHtml(evidence.quotedExcerpt)}</p></blockquote>
          ${
            source
              ? `<dl class="review-source-facts">
                   <div><dt>Source page</dt><dd>${source.title ? escapeHtml(source.title) : '<span class="value-empty">Untitled source</span>'}</dd></div>
                   <div><dt>Manufacturer domain</dt><dd><code>${escapeHtml(source.domain)}</code></dd></div>
                   <div><dt>HTTP status</dt><dd>${source.httpStatus === null ? '<span class="value-empty">Not fetched</span>' : escapeHtml(source.httpStatus)}</dd></div>
                   <div><dt>Retrieved</dt><dd>${source.fetchedAt ? formatDateTime(source.fetchedAt) : '<span class="value-empty">Never fetched</span>'}</dd></div>
                 </dl>
                 <p class="review-source-url">${
                   sourceUrl
                     ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.url)}</a>`
                     : '<span class="value-empty">Source URL is missing or not a safe HTTP(S) link.</span>'
                 }</p>
                 ${
                   sourceUrl
                     ? `<a class="button button--secondary review-source-button" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open original manufacturer page</a>`
                     : ''
                 }`
              : `<div class="alert alert--error" role="alert"><p>No source record is linked to this evidence. The quotation cannot be opened or independently checked.</p></div>`
          }
        </section>
      </div>

      <section class="panel" aria-labelledby="assessment-title">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Backend assessment</p>
            <h3 id="assessment-title">Deterministic integrity checks</h3>
          </div>
          <span class="status-pill ${assessmentItem?.overallIntegrity ? 'status-pill--good' : 'status-pill--rejected'}">
            ${assessmentItem?.overallIntegrity ? 'All checks passed' : 'Assessment failures'}
          </span>
        </div>
        ${
          assessmentItem
            ? `<div class="integrity-grid">
                 ${integrityCheckHtml('Source integrity', assessmentItem.sourceIntegrity)}
                 ${integrityCheckHtml('Quotation integrity', assessmentItem.quotationIntegrity)}
                 ${integrityCheckHtml('Claim integrity', assessmentItem.claimIntegrity)}
                 ${domainAssociationHtml(assessmentItem)}
               </div>
               <p class="panel-note assessment-note">These are the backend's deterministic assessment results. AI confidence is not a verification score and is not displayed here.</p>`
            : `<div class="alert alert--error" role="alert"><p>The backend assessment did not return this evidence record.</p></div>`
        }
      </section>

      <section class="panel" aria-labelledby="conflicts-title">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Product-level review</p>
            <h3 id="conflicts-title">Conflicts and ambiguous comparisons</h3>
          </div>
          <span class="status-pill">${formatNumber((assessment.detectedConflicts || []).length)} conflict${(assessment.detectedConflicts || []).length === 1 ? '' : 's'}</span>
        </div>
        ${renderConflictGroups(assessment, assessmentItem, evidence.id)}
      </section>

      <section class="panel review-action-panel" aria-labelledby="review-action-title">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Human decision</p>
            <h3 id="review-action-title">Review this evidence</h3>
          </div>
          <span class="status-pill ${reviewStatusClass(evidence.reviewStatus)}">Current: ${escapeHtml(reviewStatusLabel(evidence.reviewStatus))}</span>
        </div>

        <p class="panel-note">
          Accept only when the exact quotation supports the extracted claim. Reject when the claim is
          inaccurate, irrelevant or insufficiently supported. Every decision requires a note and is
          preserved in the audit history.
        </p>

        <div class="field review-note-field">
          <label for="review-note">Review note <span>(required, at least 3 characters)</span></label>
          <textarea id="review-note" rows="4" maxlength="2000" placeholder="Explain what you checked and why this decision is justified."></textarea>
        </div>
        <p id="review-note-error" class="field-error" role="alert" hidden></p>
        <div class="form-actions">
          <button id="review-accept" class="button button--primary" type="button">Accept evidence</button>
          <button id="review-reject" class="button button--secondary button--danger" type="button">Reject evidence</button>
        </div>

        <div id="review-confirm" class="review-confirm" hidden>
          <h4 id="review-confirm-title">Confirm review decision</h4>
          <p id="review-confirm-copy"></p>
          <div id="review-submit-error" class="alert alert--error" role="alert" hidden></div>
          <div class="form-actions">
            <button id="review-confirm-submit" class="button button--primary" type="button">Confirm decision</button>
            <button id="review-cancel" class="button button--quiet" type="button">Cancel</button>
          </div>
        </div>
      </section>

      <section class="panel" aria-labelledby="review-history-title">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Audit history</p>
            <h3 id="review-history-title">Review history</h3>
          </div>
          <span class="status-pill">${formatNumber((evidence.reviews || []).length)} event${(evidence.reviews || []).length === 1 ? '' : 's'}</span>
        </div>
        ${renderReviewHistory(evidence.reviews)}
      </section>

      <section class="panel publication-panel" aria-labelledby="publication-title">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Publication readiness</p>
            <h3 id="publication-title">${escapeHtml(readiness.label)}</h3>
          </div>
          <span class="status-pill ${readiness.tone}">${escapeHtml(readiness.label)}</span>
        </div>
        <div class="publication-counts">
          <span><strong>${formatNumber(readiness.accepted)}</strong> accepted</span>
          <span><strong>${formatNumber(readiness.pending)}</strong> pending</span>
          <span><strong>${formatNumber(readiness.rejected)}</strong> rejected</span>
        </div>
        <p class="panel-note">${escapeHtml(readiness.detail)} Public support information includes accepted claims only. Acceptance is not a security certification or a guarantee that updates will be delivered.</p>
        ${
          conflictOnPendingOnly
            ? '<div class="alert alert--attention"><p>Pending evidence conflicts still require review, even if public information is otherwise available from accepted claims.</p></div>'
            : ''
        }
        ${
          readiness.ready
            ? `<div class="form-actions">
                 <a class="button button--secondary" href="/api/v1/public/products/${encodeURIComponent(product.id)}/support-card" target="_blank" rel="noopener noreferrer">Open public support record</a>
               </div>
               <p class="panel-note">This build exposes the public support card as a JSON API record; no HTML support-card page exists yet.</p>`
            : '<p class="panel-note">The public support record is not linked while publication conditions are unmet.</p>'
        }
      </section>
    `;
  }

  function setReviewFormBusy(busy, decision) {
    const accept = document.getElementById('review-accept');
    const reject = document.getElementById('review-reject');
    const note = document.getElementById('review-note');
    const confirm = document.getElementById('review-confirm-submit');
    const cancel = document.getElementById('review-cancel');

    [accept, reject, note, confirm, cancel].forEach((element) => {
      if (element) element.disabled = busy;
    });
    if (confirm) {
      confirm.textContent = busy
        ? 'Recording decision…'
        : `Confirm ${decision === 'rejected' ? 'rejection' : 'acceptance'}`;
      if (busy) confirm.setAttribute('aria-busy', 'true');
      else confirm.removeAttribute('aria-busy');
    }
  }

  function wireReviewDetail(evidence, product, assessment, assessmentItem, renderSeq) {
    const accept = document.getElementById('review-accept');
    const reject = document.getElementById('review-reject');
    const confirm = document.getElementById('review-confirm');
    const cancel = document.getElementById('review-cancel');
    const confirmSubmit = document.getElementById('review-confirm-submit');
    const noteError = document.getElementById('review-note-error');
    const query = parseReviewQuery();

    function clearConfirmation() {
      state.reviewDecision = null;
      if (confirm) confirm.hidden = true;
      if (noteError) {
        noteError.hidden = true;
        noteError.textContent = '';
      }
    }

    function openConfirmation(decision) {
      if (state.reviewBusy) return;
      state.reviewDecision = decision;
      if (noteError) {
        noteError.hidden = true;
        noteError.textContent = '';
      }

      const copy = document.getElementById('review-confirm-copy');
      if (copy) {
        const replacing = ['accepted', 'rejected'].includes(evidence.reviewStatus)
          ? ` This will replace the current ${reviewStatusLabel(evidence.reviewStatus).toLowerCase()} status; the previous decision remains in the audit history.`
          : '';
        copy.textContent =
          decision === 'accepted'
            ? `You are confirming that the exact quotation accurately supports this ${claimTypeLabel(evidence.claimType).toLowerCase()} claim for ${product.name}.${replacing}`
            : `You are rejecting this ${claimTypeLabel(evidence.claimType).toLowerCase()} claim for ${product.name} as inaccurate, irrelevant or insufficiently supported.${replacing}`;
      }

      if (confirm) {
        confirm.hidden = false;
        setReviewFormBusy(false, decision);
        confirm.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    if (accept) accept.addEventListener('click', () => openConfirmation('accepted'));
    if (reject) reject.addEventListener('click', () => openConfirmation('rejected'));
    if (cancel) cancel.addEventListener('click', clearConfirmation);

    if (confirmSubmit) {
      confirmSubmit.addEventListener('click', () => {
        void submitReview({
          evidence,
          product,
          decision: state.reviewDecision,
          renderSeq,
          query,
        });
      });
    }

    document.querySelectorAll('[data-inspect-conflict]').forEach((button) => {
      button.addEventListener('click', () => {
        navigate(
          reviewPath(
            query.page,
            query.status,
            query.search,
            button.getAttribute('data-inspect-conflict'),
          ),
        );
      });
    });
  }

  async function submitReview({ evidence, product, decision, renderSeq, query }) {
    if (state.reviewBusy) return;
    if (decision !== 'accepted' && decision !== 'rejected') {
      const noteError = document.getElementById('review-note-error');
      if (noteError) {
        noteError.textContent = 'Choose accept or reject before confirming.';
        noteError.hidden = false;
      }
      return;
    }

    const note = (document.getElementById('review-note')?.value || '').trim();
    const noteError = document.getElementById('review-note-error');
    const submitError = document.getElementById('review-submit-error');

    if (note.length < 3) {
      if (noteError) {
        noteError.textContent = 'Enter a meaningful review note of at least 3 characters.';
        noteError.hidden = false;
      }
      return;
    }

    if (noteError) {
      noteError.hidden = true;
      noteError.textContent = '';
    }
    if (submitError) {
      submitError.hidden = true;
      submitError.textContent = '';
    }

    state.reviewBusy = true;
    setReviewFormBusy(true, decision);

    try {
      const body = await api(`/api/v1/evidence/${encodeURIComponent(evidence.id)}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision, reviewNote: note }),
      });
      if (renderSeq !== state.renderSeq) return;

      const updated = body?.data?.evidence;
      const review = body?.data?.review;
      if (!updated || !review || !updated.reviewStatus) {
        throw new ApiError('The server did not return the recorded review.', 500, 'INVALID_RESPONSE');
      }

      state.reviewOutcome = {
        evidenceId: evidence.id,
        status: updated.reviewStatus,
        recordedAt: review.createdAt,
      };
      state.reviewDecision = null;

      await Promise.all([
        loadReviewDetail(renderSeq, evidence.id, { focusResult: true }),
        loadReviewQueue(renderSeq, query),
      ]);
    } catch (error) {
      if (renderSeq !== state.renderSeq) return;
      if (error instanceof ApiError && error.status === 401) return;

      const message =
        error instanceof ApiError && error.code === 'SOURCE_INTEGRITY_FAILED'
          ? error.message || 'The backend rejected this acceptance because the source failed integrity checks.'
          : error instanceof ApiError && error.code === 'EVIDENCE_NOT_FOUND'
            ? 'This evidence record no longer exists.'
            : error instanceof ApiError && error.status === 400
              ? error.message || 'The review decision was invalid or the review note was missing.'
              : error.message || 'The review decision could not be saved.';

      if (submitError) {
        submitError.textContent = message;
        submitError.hidden = false;
        submitError.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      setReviewFormBusy(false, decision);
    } finally {
      state.reviewBusy = false;
    }
  }

  const acceptedHeaders = [
    ['manufacturer_name', true],
    ['product_name', true],
    ['manufacturer_website', false],
    ['manufacturer_country_code', false],
    ['model_identifier', false],
    ['gtin', false],
    ['sku', false],
    ['category', false],
    ['product_url', false],
    ['market_region', false],
  ];

  function renderImport(target, renderSeq) {
    state.importFile = null;

    target.innerHTML = `
      <section class="page" aria-labelledby="import-title">
        ${pageHeading(
          'Catalogue',
          'Import catalogue',
          'Upload a CSV of manufacturer and product rows. The server validates every row and returns the exact outcome; nothing is shown as complete until it responds.',
          `<a class="button button--secondary" href="/dashboard/products" data-link>Back to catalogue</a>`,
        )}

        <div class="import-layout">
          <section class="panel" aria-labelledby="upload-title">
            <div class="panel-head">
              <div>
                <p class="eyebrow">CSV upload</p>
                <h2 id="upload-title">Choose a catalogue file</h2>
              </div>
            </div>

            <form id="import-form" novalidate>
              <div class="dropzone" id="dropzone">
                <input
                  id="csv-file"
                  class="file-input"
                  type="file"
                  accept=".csv,text/csv"
                  aria-label="Choose a CSV catalogue file"
                />
                <div class="dropzone-content" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                  </svg>
                  <strong>Drop a CSV here, or choose a file</strong>
                  <span>Maximum 5 MB and 500 data rows. UTF-8 CSV with a header row.</span>
                </div>
              </div>

              <p id="file-status" class="file-status" aria-live="polite">No file selected.</p>
              <div id="import-alert" class="alert alert--error" role="alert" hidden></div>

              <div id="upload-state" class="upload-state" hidden>
                <div class="upload-state-head">
                  <span id="upload-label">Uploading…</span>
                  <span id="upload-percent" class="mono">0%</span>
                </div>
                <progress id="upload-progress" max="100" value="0" aria-label="CSV upload progress">0%</progress>
              </div>

              <div class="form-actions">
                <button id="import-submit" class="button button--primary" type="submit" disabled>
                  Import catalogue
                </button>
                <button id="clear-file" class="button button--quiet" type="button" hidden>
                  Clear file
                </button>
              </div>
            </form>
          </section>

          <aside class="panel import-reference" aria-labelledby="headers-title">
            <div class="panel-head">
              <div>
                <p class="eyebrow">Format</p>
                <h2 id="headers-title">Accepted CSV headers</h2>
              </div>
            </div>
            <ul class="header-list">
              ${acceptedHeaders
                .map(
                  ([header, required]) => `
                    <li>
                      <code>${header}</code>
                      <span class="header-requirement">${required ? 'Required' : 'Optional'}</span>
                    </li>
                  `,
                )
                .join('')}
            </ul>
            <p class="panel-note">
              Unknown columns are ignored and reported after import. Header names are
              case-insensitive; spaces and hyphens are treated as underscores.
            </p>
            <button id="download-sample" class="button button--secondary button--full" type="button">
              Download synthetic sample CSV
            </button>
            <p class="sample-note">
              The sample contains fictional products marked as synthetic test data. It is not a
              real catalogue.
            </p>
          </aside>
        </div>

        <div id="import-result" class="import-result" aria-live="polite"></div>
      </section>
    `;

    const form = document.getElementById('import-form');
    const fileInput = document.getElementById('csv-file');
    const dropzone = document.getElementById('dropzone');
    const status = document.getElementById('file-status');
    const alertBox = document.getElementById('import-alert');
    const submit = document.getElementById('import-submit');
    const clearButton = document.getElementById('clear-file');
    const uploadState = document.getElementById('upload-state');
    const progress = document.getElementById('upload-progress');
    const uploadLabel = document.getElementById('upload-label');
    const uploadPercent = document.getElementById('upload-percent');
    const result = document.getElementById('import-result');

    function showAlert(message) {
      alertBox.textContent = message;
      alertBox.hidden = false;
    }

    function clearAlert() {
      alertBox.hidden = true;
      alertBox.textContent = '';
    }

    function setFile(file) {
      clearAlert();
      result.innerHTML = '';
      state.importFile = null;
      submit.disabled = true;
      clearButton.hidden = true;
      uploadState.hidden = true;
      progress.value = 0;
      uploadPercent.textContent = '0%';

      if (!file) {
        status.textContent = 'No file selected.';
        return;
      }

      if (file.size === 0) {
        status.textContent = 'No file selected.';
        showAlert('That file is empty. Choose a CSV with a header row and at least one data row.');
        fileInput.value = '';
        return;
      }

      if (file.size > 5 * 1024 * 1024) {
        status.textContent = 'No file selected.';
        showAlert('The file is larger than 5 MB. Reduce the file and try again.');
        fileInput.value = '';
        return;
      }

      if (!/\.csv$/i.test(file.name)) {
        status.textContent = 'No file selected.';
        showAlert('Choose a file with a .csv extension.');
        fileInput.value = '';
        return;
      }

      state.importFile = file;
      status.textContent = `${file.name} — ${formatBytes(file.size)}. Ready to import.`;
      submit.disabled = false;
      clearButton.hidden = false;
    }

    fileInput.addEventListener('change', () => {
      setFile(fileInput.files && fileInput.files[0] ? fileInput.files[0] : null);
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.add('is-dragging');
      });
    });

    ['dragleave', 'dragend'].forEach((eventName) => {
      dropzone.addEventListener(eventName, () => dropzone.classList.remove('is-dragging'));
    });

    dropzone.addEventListener('drop', (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-dragging');
      const files = event.dataTransfer && event.dataTransfer.files;
      if (files && files[0]) setFile(files[0]);
    });

    clearButton.addEventListener('click', () => {
      fileInput.value = '';
      setFile(null);
      result.innerHTML = '';
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!state.importFile) return;
      uploadCatalogue(state.importFile);
    });

    function uploadCatalogue(file) {
      clearAlert();
      result.innerHTML = '';
      setBusy(true);

      const formData = new FormData();
      formData.append('file', file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/v1/catalogue/imports');
      xhr.withCredentials = true;
      xhr.responseType = 'text';

      xhr.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
        progress.value = percent;
        uploadPercent.textContent = `${percent}%`;
        uploadLabel.textContent = percent >= 100 ? 'Validating and importing…' : 'Uploading…';
      });

      xhr.upload.addEventListener('load', () => {
        uploadLabel.textContent = 'Validating and importing…';
        progress.removeAttribute('value');
        uploadPercent.textContent = 'Working';
      });

      xhr.addEventListener('load', () => {
        setBusy(false);

        let body = null;
        try {
          body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          body = null;
        }

        if (xhr.status === 401) {
          redirectToLogin();
          return;
        }

        if (xhr.status === 200 && body && body.summary && Array.isArray(body.results)) {
          renderImportResult(body);
          state.importFile = null;
          submit.disabled = true;
          clearButton.hidden = true;
          status.textContent = 'Import complete. Review the server results below.';
          return;
        }

        const message =
          body && body.error && body.error.message
            ? body.error.message
            : `The import failed (${xhr.status || 'network error'}).`;
        showAlert(message);
        uploadState.hidden = true;
        uploadPercent.textContent = '0%';
      });

      xhr.addEventListener('error', () => {
        setBusy(false);
        uploadState.hidden = true;
        showAlert('The upload could not reach the server. Check your connection and try again.');
      });

      xhr.addEventListener('abort', () => {
        setBusy(false);
        uploadState.hidden = true;
      });

      xhr.send(formData);

      function setBusy(busy) {
        submit.disabled = busy;
        clearButton.disabled = busy;
        fileInput.disabled = busy;
        submit.textContent = busy ? 'Importing…' : 'Import catalogue';
        uploadState.hidden = !busy;
        if (busy) {
          uploadLabel.textContent = 'Uploading…';
          progress.value = 0;
          progress.setAttribute('max', '100');
          uploadPercent.textContent = '0%';
        }
        if (busy) submit.setAttribute('aria-busy', 'true');
        else submit.removeAttribute('aria-busy');
      }
    }

    function renderImportResult(body) {
      const summary = body.summary || {};
      const results = Array.isArray(body.results) ? body.results : [];
      const warnings = Array.isArray(body.warnings) ? body.warnings : [];
      const ignoredColumns = Array.isArray(body.ignoredColumns) ? body.ignoredColumns : [];
      const rejected = results.filter((item) => item.status === 'rejected');

      const rejectedRows = rejected
        .map((item) => {
          const errors = Array.isArray(item.errors) ? item.errors : [];
          return errors
            .map(
              (error) => `
                <tr>
                  <td data-label="Row">${escapeHtml(item.row)}</td>
                  <td data-label="Field"><code>${valueOrDash(error.field)}</code></td>
                  <td data-label="Validation error">${escapeHtml(error.message)}</td>
                </tr>
              `,
            )
            .join('');
        })
        .join('');

      const allRows = results
        .map((item) => {
          let detail = '';
          if (item.status === 'created') detail = `Product ${escapeHtml(item.productId)}`;
          else if (item.status === 'duplicate') detail = escapeHtml(item.reason);
          else if (item.status === 'rejected') {
            detail = (item.errors || [])
              .map((error) => `${error.field}: ${error.message}`)
              .join('; ');
          }
          return `
            <tr>
              <td data-label="Row">${escapeHtml(item.row)}</td>
              <td data-label="Outcome"><span class="row-status row-status--${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td>
              <td data-label="Detail">${escapeHtml(detail)}</td>
            </tr>
          `;
        })
        .join('');

      result.innerHTML = `
        <section class="panel import-summary" aria-labelledby="import-result-title" tabindex="-1">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Server response</p>
              <h2 id="import-result-title">Import complete</h2>
            </div>
            <span class="status-pill">${formatNumber(summary.totalRows)} rows processed</span>
          </div>

          <div class="summary-grid">
            <div class="summary-stat"><span>Created</span><strong>${formatNumber(summary.created)}</strong></div>
            <div class="summary-stat"><span>Duplicates</span><strong>${formatNumber(summary.duplicates)}</strong></div>
            <div class="summary-stat"><span>Failed</span><strong>${formatNumber(summary.failed)}</strong></div>
            <div class="summary-stat"><span>Total rows</span><strong>${formatNumber(summary.totalRows)}</strong></div>
          </div>

          ${
            rejected.length > 0
              ? `<div class="result-section">
                   <h3>Row validation errors</h3>
                   <div class="table-wrap">
                     <table class="data-table data-table--errors">
                       <caption class="visually-hidden">Rejected rows and their validation errors</caption>
                       <thead><tr><th scope="col">Row</th><th scope="col">Field</th><th scope="col">Error</th></tr></thead>
                       <tbody>${rejectedRows}</tbody>
                     </table>
                   </div>
                 </div>`
              : '<p class="result-ok">No row-level validation errors were reported.</p>'
          }

          ${
            warnings.length > 0
              ? `<div class="result-section"><h3>Manufacturer metadata warnings</h3><ul class="result-list">${warnings
                  .map((warning) => `<li>${escapeHtml(warning)}</li>`)
                  .join('')}</ul></div>`
              : ''
          }

          <div class="result-section">
            <h3>Ignored columns</h3>
            ${
              ignoredColumns.length > 0
                ? `<div class="chip-row">${ignoredColumns
                    .map((column) => `<code>${escapeHtml(column)}</code>`)
                    .join('')}</div>`
                : '<p class="muted">None. Every column in the file matched a known header.</p>'
            }
          </div>

          ${
            results.length > 0
              ? `<details class="result-details">
                   <summary>View all ${formatNumber(results.length)} row results</summary>
                   <div class="table-wrap">
                     <table class="data-table">
                       <caption class="visually-hidden">Every row result returned by the import</caption>
                       <thead><tr><th scope="col">Row</th><th scope="col">Outcome</th><th scope="col">Detail</th></tr></thead>
                       <tbody>${allRows}</tbody>
                     </table>
                   </div>
                 </details>`
              : ''
          }

          <div class="form-actions">
            <a class="button button--primary" href="/dashboard/products" data-link>View catalogue</a>
            <button id="import-again" class="button button--secondary" type="button">Import another file</button>
          </div>
        </section>
      `;

      const importAgain = document.getElementById('import-again');
      if (importAgain) {
        importAgain.addEventListener('click', () => navigate('/dashboard/import', { replace: true }));
      }

      const heading = result.querySelector('#import-result-title');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({ block: 'start' });
      }
    }

    const sampleButton = document.getElementById('download-sample');
    if (sampleButton) {
      sampleButton.addEventListener('click', downloadSample);
    }
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function downloadSample() {
    const rows = [
      ['manufacturer_name', 'manufacturer_website', 'manufacturer_country_code', 'product_name', 'model_identifier', 'gtin', 'category', 'market_region', 'data_note'],
      ['Northline Audio (Sample)', 'https://northline.example', 'DE', 'Halo S1 home speaker', 'SAMPLE-NL-S1', '5901234123457', 'Home audio', 'DE', 'SYNTHETIC SAMPLE - not a real product'],
      ['Verdant Home (Sample)', 'https://verdant.example', 'FR', 'Aria air purifier', 'SAMPLE-VH-A1', '4006381333931', 'Home appliance', 'FR', 'SYNTHETIC SAMPLE - not a real product'],
    ];
    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ss-tool-sample-catalogue.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvCell(value) {
    const text = String(value);
    // Prefix formula-leading cells so spreadsheet software treats sample data as
    // text rather than executing it.
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  }

  function setupShell() {
    menuToggle.addEventListener('click', () => {
      if (state.navOpen) closeNav(true);
      else openNav();
    });

    navBackdrop.addEventListener('click', () => closeNav(true));

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.navOpen) {
        closeNav(true);
      }
    });

    mobileQuery.addEventListener('change', () => {
      if (!mobileQuery.matches) {
        state.navOpen = false;
        sidebar.classList.remove('is-open');
        navBackdrop.hidden = true;
        menuToggle.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('nav-open');
      }
      syncNavInert();
    });

    syncNavInert();

    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[data-link]');
      if (!link) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      navigate(url.pathname + url.search);
    });

    window.addEventListener('popstate', renderRoute);

    logoutButton.addEventListener('click', async () => {
      logoutButton.disabled = true;
      logoutButton.textContent = 'Logging out…';
      try {
        await api('/api/v1/auth/logout', { method: 'POST' });
      } catch {
        // Redirect regardless: the cookie is cleared server-side when possible.
      } finally {
        window.location.assign('/login');
      }
    });
  }

  async function boot() {
    setupShell();

    try {
      const body = await api('/api/v1/auth/session');
      state.session = body && body.data ? body.data : null;
      if (!state.session || !state.session.email) {
        redirectToLogin();
        return;
      }
      accountEmail.textContent = state.session.email;
      accountEmail.title = state.session.email;
      const avatar = document.querySelector('.account-avatar');
      if (avatar) {
        avatar.textContent = state.session.email.slice(0, 2).toUpperCase();
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      renderErrorState(
        error.message || 'The workspace could not be loaded.',
        { title: 'Workspace unavailable' },
      );
      return;
    }

    renderRoute();
  }

  boot();
})();
