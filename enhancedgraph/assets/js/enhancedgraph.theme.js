/*
** Enhanced graph theme: redraws classic Zabbix graph images (chart.php / chart2.php) with EnhancedGraph.
**
** How it stays safe and removable:
**  - The original <img> stays in the page (invisible) so Zabbix' own zoom selection, double-click zoom out,
**    time selector, auto-refresh and links keep working exactly as before. The new drawing sits on top with
**    its plot area aligned to the classic one and lets mouse events through to the image.
**  - Data comes from the module's read-only "enhancedgraph.data" action.
**  - "Classic graph" / "Enhanced graph" button on every graph switches the look for this browser.
**  - Disabling the module in Administration > General > Modules removes all of this.
*/

(function () {
	'use strict';

	if (window.EnhancedGraphTheme || typeof EnhancedGraph === 'undefined') {
		return;
	}

	const MODE_KEY = 'enhancedgraph.mode';
	const CHART_RE = /(^|\/)(chart|chart2)\.php(\?|$)/;
	const REFRESH_DEBOUNCE_MS = 30;

	// A classic image that we could not replace within this time is shown again (never leave a blank graph).
	const FALLBACK_MS = 10000;

	let mode = readMode();

	// While enhanced, classic graph images are hidden from the start (CSS), so the old graph never flashes.
	function applyModeClass() {
		document.documentElement.classList.toggle('eg-on', mode === 'enhanced');
	}

	applyModeClass();

	// Data requests started as soon as an image URL is set, so data and image load at the same time.
	const prefetched = new Map();
	// Graphs the server said to leave classic (e.g. pie charts): show those images immediately next time.
	const skipped = new Set();

	function readMode() {
		try {
			return localStorage.getItem(MODE_KEY) === 'classic' ? 'classic' : 'enhanced';
		}
		catch (e) {
			return 'enhanced';
		}
	}

	function writeMode(value) {
		try {
			localStorage.setItem(MODE_KEY, value);
		}
		catch (e) {
			// Private mode etc.: the switch still works for this page.
		}
	}

	function isChart(img) {
		return img instanceof HTMLImageElement && CHART_RE.test(img.getAttribute('src') || '');
	}

	/** Build the data request from the classic image URL (same graph, same period). */
	function requestFor(img) {
		const url = new URL(img.getAttribute('src'), location.href);
		const script = url.pathname.split('/').pop();
		const q = new URLSearchParams({action: 'enhancedgraph.data'});

		if (script === 'chart2.php') {
			const graphid = url.searchParams.get('graphid');

			if (!graphid) {
				return null;
			}

			q.set('graphid', graphid);
		}
		else {
			const itemids = [];

			for (const [key, value] of url.searchParams) {
				if (key === 'itemids' || key.startsWith('itemids[')) {
					itemids.push(value);
				}
			}

			if (!itemids.length) {
				return null;
			}

			itemids.forEach(id => q.append('itemids[]', id));
		}

		if (url.searchParams.get('batch')) {
			q.set('batch', '1');
		}

		q.set('from', url.searchParams.get('from') || 'now-1h');
		q.set('to', url.searchParams.get('to') || 'now');
		// Number of points: the classic image width is a good upper bound (the server caps it as well).
		q.set('width', String(Math.max(50, Math.min(2000, parseInt(url.searchParams.get('width'), 10) || 1000))));

		return q;
	}

	function graphKey(request) {
		return request.get('graphid') ? 'g' + request.get('graphid') : 'i' + request.getAll('itemids[]').join(',');
	}

	function fetchData(request) {
		const key = request.toString();

		if (prefetched.has(key)) {
			const promise = prefetched.get(key);
			prefetched.delete(key);

			return promise;
		}

		return fetch('zabbix.php?' + key, {credentials: 'same-origin', headers: {Accept: 'application/json'}})
			.then((response) => response.json());
	}

	/** Start loading data for an image whose URL was just set (image still downloading). */
	function prefetch(img) {
		if (mode !== 'enhanced' || !isChart(img)) {
			return;
		}

		const request = requestFor(img);

		if (request === null) {
			img.classList.add('eg-classic');
			return;
		}

		if (skipped.has(graphKey(request))) {
			img.classList.add('eg-classic');
			return;
		}

		const key = request.toString();

		if (!prefetched.has(key)) {
			const promise = fetch('zabbix.php?' + key, {credentials: 'same-origin', headers: {Accept: 'application/json'}})
				.then((response) => response.json());

			promise.catch(() => {});
			prefetched.set(key, promise);

			// Forget unused results (e.g. the image was replaced again before it loaded).
			setTimeout(() => prefetched.delete(key), 60000);
		}

		armFallback(img);
	}

	/** If nothing replaced the hidden classic image in time, show it again. */
	function armFallback(img) {
		clearTimeout(img._eg_fallback);
		img._eg_fallback = setTimeout(() => {
			const overlay = img.nextElementSibling;

			if (!(overlay && overlay.classList && overlay.classList.contains('eg-active'))) {
				img.classList.add('eg-classic');
			}
		}, FALLBACK_MS);
	}

	/**
	 * Enhanced style for classic graph definitions: the new colour palette in item order (first = green,
	 * second = blue, ...), filled/gradient items as solid areas, bold lines as normal lines. Which items, axes,
	 * stacking, min/avg/max and trigger lines are shown still follows the graph definition.
	 */
	function applyStyle(data) {
		const style_of = {gradient: 'area', area: 'area', bold: 'line', line: 'line', dot: 'dot', dashed: 'dashed'};

		data.series.forEach((s, i) => {
			s.color = EnhancedGraph.PALETTE[i % EnhancedGraph.PALETTE.length];
			s.drawtype = style_of[s.drawtype] || 'line';
		});

		return data;
	}

	/** Plot area of the classic image, as used by Zabbix' selection box (gtlc.js). */
	function frameFor(img, natural_height) {
		const sbox = window.jQuery ? window.jQuery(img).data('zbx_sbox') : null;

		if (sbox && sbox.height > 0) {
			return {
				left: Number(sbox.left) || 0,
				right: Number(sbox.right) || 0,
				top: Number(sbox.top) || 0,
				height: Number(sbox.height)
			};
		}

		// No selection box (e.g. template dashboards): classic-like margins.
		return {left: 70, right: 30, top: 28, height: Math.max(100, natural_height - 28 - 60)};
	}

	// ------------------------------------------------------------------------------------------ overlay handling

	function getState(img) {
		// A refresh may have replaced the <img> element; reuse the overlay next to it to avoid flicker.
		let overlay = img.nextElementSibling;

		if (!overlay || !overlay.classList.contains('eg-overlay')) {
			overlay = document.createElement('div');
			overlay.className = 'eg-overlay';

			const holder = document.createElement('div');
			holder.className = 'eg-overlay-graph';

			const toggle = document.createElement('button');
			toggle.type = 'button';
			toggle.className = 'eg-toggle';
			toggle.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				setMode(mode === 'enhanced' ? 'classic' : 'enhanced');
			});

			overlay.append(holder, toggle);

			// Clicks on the legend must not follow the graph's parent link (dashboard graph widget).
			overlay.addEventListener('click', (e) => {
				if (e.target.closest('.eg-graph-legend')) {
					e.preventDefault();
				}
			});

			img.insertAdjacentElement('afterend', overlay);
			overlay._eg = {overlay, holder, toggle, graph: null, req: 0, height: 0, width: 0, frame: null};
		}

		overlay._eg.img = img;

		return overlay._eg;
	}

	function place(st) {
		const {img, overlay} = st;

		overlay.style.left = img.offsetLeft + 'px';
		overlay.style.top = img.offsetTop + 'px';
		overlay.style.width = img.offsetWidth + 'px';
	}

	function updateToggle(st) {
		st.toggle.textContent = mode === 'enhanced' ? 'Classic graph' : 'Enhanced graph';
		st.toggle.title = mode === 'enhanced' ? 'Show the standard Zabbix graph' : 'Show the enhanced graph';
	}

	function showClassic(st, hide_toggle = false) {
		st.img.classList.add('eg-classic');
		st.overlay.classList.remove('eg-active');
		st.overlay.classList.toggle('eg-toggle-hidden', hide_toggle);
		st.img.style.opacity = '';
		st.img.style.height = '';
		st.img.style.width = '';
		updateToggle(st);
		place(st);
	}

	function showEnhanced(st) {
		st.img.classList.remove('eg-classic');
		st.overlay.classList.add('eg-active');
		st.overlay.classList.remove('eg-toggle-hidden');
		st.img.style.opacity = '0';
		// Set both: with only a height the browser would scale the width to keep the image aspect ratio.
		st.img.style.width = st.width + 'px';
		st.img.style.height = st.height + 'px';
		updateToggle(st);
		place(st);
	}

	function enhance(img) {
		if (!isChart(img) || !img.isConnected || !img.complete || img.naturalWidth === 0) {
			return;
		}

		const st = getState(img);
		const natural_height = img.naturalHeight;

		if (mode === 'classic') {
			showClassic(st);
			return;
		}

		const request = requestFor(img);

		if (request === null) {
			showClassic(st, true);
			return;
		}

		// Keep the previous drawing in place while the new data loads (no flicker on refresh).
		if (st.graph !== null) {
			showEnhanced(st);
		}

		const width = img.style.width ? img.naturalWidth : (img.offsetWidth || img.naturalWidth);
		const frame = frameFor(img, natural_height);
		const key = graphKey(request);

		armFallback(img);

		const req = ++st.req;

		fetchData(request)
			.then((data) => {
				if (req !== st.req || !st.img.isConnected || mode !== 'enhanced') {
					return;
				}

				if (data.skip || data.error || !Array.isArray(data.series)) {
					if (data.skip) {
						skipped.add(key);
					}

					showClassic(st, true);
					return;
				}

				if (st.graph === null) {
					st.graph = new EnhancedGraph(st.holder, {});
				}

				// The container must be visible while drawing, otherwise the legend measures 0 px high.
				st.overlay.classList.add('eg-active');

				st.graph.setOptions({
					theme: 'auto',
					title: data.title || '',
					show_header: false,
					show_legend: data.show_legend !== false,
					frame
				});
				st.graph.setSize(width, natural_height);
				st.graph.setData(applyStyle(data));

				st.height = st.graph.getHeight();
				st.width = width;
				st.frame = frame;

				showEnhanced(st);
			})
			.catch(() => {
				if (req === st.req) {
					showClassic(st, true);
				}
			});
	}

	const pending = new Set();
	let pending_timer = null;

	/** Queue an image; handled shortly after so Zabbix can attach its selection-box data first. */
	function schedule(img) {
		if (!isChart(img)) {
			return;
		}

		pending.add(img);
		clearTimeout(pending_timer);
		pending_timer = setTimeout(() => {
			const list = [...pending];
			pending.clear();
			list.forEach(enhance);
		}, REFRESH_DEBOUNCE_MS);
	}

	function scanAll() {
		document.querySelectorAll('img').forEach((img) => {
			if (isChart(img) && img.complete) {
				schedule(img);
			}
		});
	}

	function setMode(value) {
		mode = value;
		writeMode(value);
		applyModeClass();
		scanAll();
	}

	// ------------------------------------------------------------------------------------------ wiring

	// Image (re)loaded in place: Monitoring > Graphs changes the src of the same <img>.
	document.addEventListener('load', (e) => {
		if (e.target instanceof HTMLImageElement) {
			schedule(e.target);
		}
	}, true);

	// Image replaced by a new, already loaded element: Latest data graph and dashboard graph widgets.
	new MutationObserver((mutations) => {
		for (const m of mutations) {
			for (const node of m.addedNodes) {
				if (node instanceof HTMLImageElement) {
					prefetch(node);

					// Keep the enhanced drawing's size immediately so the page does not jump on refresh.
					const overlay = node.nextElementSibling;

					if (overlay && overlay._eg && overlay.classList.contains('eg-active') && mode === 'enhanced') {
						node.style.width = overlay._eg.width + 'px';
						node.style.height = overlay._eg.height + 'px';
					}

					if (node.complete) {
						schedule(node);
					}
				}
				else if (node instanceof Element) {
					node.querySelectorAll('img').forEach((img) => {
						prefetch(img);

						if (img.complete) {
							schedule(img);
						}
					});
				}
			}

			if (m.type === 'attributes' && m.target instanceof HTMLImageElement) {
				prefetch(m.target);
			}
		}
	}).observe(document.documentElement, {childList: true, subtree: true, attributes: true, attributeFilter: ['src']});

	// Hover values: mouse events go to the classic image (so Zabbix zoom keeps working); forward them.
	document.addEventListener('mousemove', (e) => {
		const img = e.target;

		if (img instanceof HTMLImageElement && mode === 'enhanced') {
			const overlay = img.nextElementSibling;

			if (overlay && overlay._eg && overlay._eg.graph && overlay.classList.contains('eg-active')) {
				overlay._eg.graph.pointerMove(e);
			}
		}
	}, true);

	document.addEventListener('mouseout', (e) => {
		const img = e.target;

		if (img instanceof HTMLImageElement) {
			const overlay = img.nextElementSibling;

			if (overlay && overlay._eg && overlay._eg.graph) {
				overlay._eg.graph.pointerLeave();
			}
		}
	}, true);

	// Keep overlays aligned when the layout changes.
	let resize_timer = null;
	window.addEventListener('resize', () => {
		clearTimeout(resize_timer);
		resize_timer = setTimeout(() => {
			document.querySelectorAll('.eg-overlay').forEach((overlay) => {
				if (overlay._eg && overlay._eg.img && overlay._eg.img.isConnected) {
					place(overlay._eg);
				}
			});
		}, 100);
	});

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', scanAll);
	}
	else {
		scanAll();
	}

	window.EnhancedGraphTheme = {setMode, getMode: () => mode, refresh: scanAll};
})();
