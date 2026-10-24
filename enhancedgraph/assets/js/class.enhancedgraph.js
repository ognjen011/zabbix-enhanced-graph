/*
** Enhanced graph renderer for Zabbix graphs.
**
** Standalone (no jQuery / no Zabbix dependencies) so the same file drives both the Zabbix theme module and the
** local preview page.
**
** Data format passed to setData():
**   {
**     time_from: <unix ts>, time_to: <unix ts>,
**     graph_type: 'area' | 'line' | 'stacked' | 'classic' (classic = each series uses its own drawtype),
**     axes: [{min, max}, {min, max}],       // optional fixed Y range per axis (null = automatic)
**     series: [{
**       name, host, units, color,
**       axis: 0 | 1,                        // optional; default: first unit left, other units right
**       drawtype: 'line' | 'area' | 'bold' | 'dot' | 'dashed' | 'gradient',   // used by 'classic'
**       mirror: bool,                       // draw below the zero line
**       points: [[clock, value, min, max], ...],
**       stats: {min, max, avg, last}        // optional, computed from points if missing
**     }]
**   }
**
** Option `frame` = {left, right, top, height} pins the plot area to exact pixel margins (used to sit exactly on
** top of a classic Zabbix graph image so Zabbix' own zoom selection keeps working).
*/

class EnhancedGraph {

	static PALETTE = [
		'#00d16a', '#1e90ff', '#ff8c1a', '#d63fd6', '#a5d22d', '#13c2c2', '#8c6cff', '#ffcc00',
		'#ff4d4f', '#2fbf9f', '#5b8ff9', '#f6903d', '#e86452', '#6dc8ec', '#9270ca', '#ff9d4d'
	];

	static NO_SCALE_UNITS = ['%', 'ms', 'rpm', 'RPM', 'unixtime', 'uptime', '°C', 'C', 'dBm', 'dB', ''];

	static BINARY_UNITS = ['B', 'Bps', 'B/s'];

	static UNIT_ALIASES = {bps: 'bit/s', Bps: 'B/s'};

	// Space under the plot for the time labels when the plot area is pinned (frame mode).
	static FRAME_BOTTOM = 24;

	static injectStyles() {
		if (document.getElementById('eg-graph-styles')) {
			return;
		}

		const style = document.createElement('style');
		style.id = 'eg-graph-styles';
		style.textContent = EnhancedGraph.CSS;
		document.head.appendChild(style);
	}

	constructor(container, options = {}) {
		EnhancedGraph.injectStyles();

		this.container = container;
		// Zoom: when `zoomable` is true, dragging across the plot calls onZoom({from_offset, to_offset}) with
		// seconds to cut from the start/end of the period (same contract as Zabbix "rangeoffset"),
		// double-click calls onZoomOut(). onDragStart/onDragEnd let the caller pause refreshes.
		this.options = {
			theme: 'auto', show_legend: true, show_header: true, title: '',
			zoomable: false, min_period: 60, frame: null,
			onZoom: null, onZoomOut: null, onDragStart: null, onDragEnd: null,
			...options
		};
		this.data = null;
		this.hidden = new Set();
		this.width = 0;
		this.height = 0;

		this.root = document.createElement('div');
		this.root.className = 'eg-graph';
		this.container.appendChild(this.root);

		this.header = document.createElement('div');
		this.header.className = 'eg-graph-header';

		this.plot = document.createElement('div');
		this.plot.className = 'eg-graph-plot';

		this.legend = document.createElement('div');
		this.legend.className = 'eg-graph-legend';

		this.tooltip = document.createElement('div');
		this.tooltip.className = 'eg-graph-tooltip';

		this.root.append(this.header, this.plot, this.legend);
		this.plot.appendChild(this.tooltip);

		this._applyTheme();
	}

	destroy() {
		this._pointer = null;
		this.root.remove();
	}

	setSize(width, height) {
		this.width = Math.max(120, Math.floor(width));
		this.height = Math.max(80, Math.floor(height));
		this.root.style.width = this.width + 'px';
		this.root.style.height = this.height + 'px';
		this.render();
	}

	setOptions(options) {
		this.options = {...this.options, ...options};
		this._applyTheme();
		this.render();
	}

	setData(data) {
		this.data = data;

		const used = new Set();

		data.series.forEach((s, i) => {
			if (!s.color) {
				s.color = EnhancedGraph.PALETTE[i % EnhancedGraph.PALETTE.length];
			}

			if (!s.stats) {
				s.stats = EnhancedGraph.computeStats(s.points);
			}

			used.add(s.key ?? i);
		});

		for (const key of [...this.hidden]) {
			if (!used.has(key)) {
				this.hidden.delete(key);
			}
		}

		this.render();
	}

	_applyTheme() {
		let theme = this.options.theme;

		if (theme === 'auto') {
			const scheme = document.documentElement.getAttribute('color-scheme');
			theme = scheme === 'dark' ? 'dark' : 'light';
		}

		this.root.setAttribute('data-theme', theme);
	}

	static computeStats(points) {
		let min = null, max = null, sum = 0, n = 0, last = null;

		for (const [, avg, pmin, pmax] of points) {
			if (avg === null || avg === undefined) {
				continue;
			}

			const lo = pmin ?? avg;
			const hi = pmax ?? avg;

			min = min === null ? lo : Math.min(min, lo);
			max = max === null ? hi : Math.max(max, hi);
			sum += avg;
			n++;
			last = avg;
		}

		return {min, max, avg: n ? sum / n : null, last};
	}

	// ---------------------------------------------------------------------------------------------- formatting

	static displayUnits(units) {
		return EnhancedGraph.UNIT_ALIASES[units] ?? units;
	}

	static formatValue(value, units, decimals = null) {
		if (value === null || value === undefined || isNaN(value)) {
			return 'n/a';
		}

		if (units === 's') {
			return EnhancedGraph.formatSeconds(value);
		}

		if (units === 'unixtime') {
			return new Date(value * 1000).toLocaleString();
		}

		if (units === 'uptime') {
			return EnhancedGraph.formatSeconds(value);
		}

		if (typeof units === 'string' && units.startsWith('!')) {
			const raw = units.slice(1);
			return EnhancedGraph._round(value, decimals) + (raw ? ' ' + raw : '');
		}

		const shown = EnhancedGraph.displayUnits(units);

		if (EnhancedGraph.NO_SCALE_UNITS.includes(units)) {
			return EnhancedGraph._round(value, decimals) + (shown ? ' ' + shown : '');
		}

		const base = EnhancedGraph.BINARY_UNITS.includes(units) ? 1024 : 1000;
		const prefixes = base === 1024 ? ['', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi'] : ['', 'k', 'M', 'G', 'T', 'P'];
		let abs = Math.abs(value);
		let i = 0;

		while (abs >= base && i < prefixes.length - 1) {
			abs /= base;
			i++;
		}

		const scaled = Math.sign(value) * abs;

		return EnhancedGraph._round(scaled, decimals) + ' ' + prefixes[i] + shown;
	}

	static _round(value, decimals) {
		if (decimals === null) {
			const abs = Math.abs(value);
			decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
		}

		return Number(value.toFixed(decimals)).toLocaleString(undefined, {maximumFractionDigits: decimals});
	}

	static formatSeconds(value) {
		const abs = Math.abs(value);

		if (abs === 0) {
			return '0 s';
		}
		if (abs < 0.001) {
			return (value * 1e6).toFixed(0) + ' µs';
		}
		if (abs < 1) {
			return (value * 1000).toFixed(abs < 0.01 ? 2 : 1) + ' ms';
		}
		if (abs < 60) {
			return value.toFixed(abs < 10 ? 2 : 1) + ' s';
		}
		if (abs < 3600) {
			return (value / 60).toFixed(1) + ' min';
		}
		if (abs < 86400) {
			return (value / 3600).toFixed(1) + ' h';
		}

		return (value / 86400).toFixed(1) + ' d';
	}

	static formatDuration(seconds) {
		const parts = [];
		const units = [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];
		let rest = seconds;

		for (const [label, size] of units) {
			if (rest >= size) {
				parts.push(Math.floor(rest / size) + label);
				rest %= size;
			}
			if (parts.length === 2) {
				break;
			}
		}

		return parts.length ? parts.join(' ') : '0s';
	}

	static formatTime(ts, span) {
		const d = new Date(ts * 1000);
		const pad = (n) => String(n).padStart(2, '0');

		if (span <= 2 * 86400) {
			return pad(d.getHours()) + ':' + pad(d.getMinutes());
		}
		if (span <= 14 * 86400) {
			return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + pad(d.getHours()) + ':00';
		}

		return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.';
	}

	static formatDateTime(ts) {
		const d = new Date(ts * 1000);
		const pad = (n) => String(n).padStart(2, '0');

		return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' '
			+ pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
	}

	// ---------------------------------------------------------------------------------------------- scales

	static niceCeil(value) {
		if (value <= 0) {
			return 1;
		}

		const mag = Math.pow(10, Math.floor(Math.log10(value)));
		const norm = value / mag;

		return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
	}

	static niceStep(range, ticks) {
		const raw = range / Math.max(1, ticks);
		const mag = Math.pow(10, Math.floor(Math.log10(raw)));
		const norm = raw / mag;
		const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;

		return step * mag;
	}

	static timeTicks(from, to, max_ticks) {
		const span = to - from;
		const steps = [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 2592000];
		let step = steps[steps.length - 1];

		for (const s of steps) {
			if (span / s <= max_ticks) {
				step = s;
				break;
			}
		}

		const tz_offset = new Date(from * 1000).getTimezoneOffset() * 60;
		const ticks = [];
		let t = Math.ceil((from - tz_offset) / step) * step + tz_offset;

		for (; t <= to; t += step) {
			ticks.push(t);
		}

		return ticks;
	}

	// ---------------------------------------------------------------------------------------------- rendering

	render() {
		if (!this.data || !this.width) {
			return;
		}

		this._applyTheme();
		// Must be set before the legend is measured (frame mode: legend is not height-limited).
		this.root.toggleAttribute('data-frame', !!this.options.frame);
		this._renderHeader();
		this._renderLegend();

		const legend_h = this.options.show_legend ? this.legend.offsetHeight : 0;

		if (this.options.frame) {
			// Fixed plot geometry; total height follows from it.
			const f = this.options.frame;
			const plot_h = f.top + f.height + EnhancedGraph.FRAME_BOTTOM;

			this.plot.style.height = plot_h + 'px';
			this.height = plot_h + legend_h;
			this.root.style.height = this.height + 'px';
			this._renderPlot(this.width, plot_h);

			return;
		}

		const header_h = this.options.show_header ? this.header.offsetHeight : 0;
		const plot_h = Math.max(60, this.height - header_h - legend_h);

		this.plot.style.height = plot_h + 'px';
		this._renderPlot(this.width, plot_h);
	}

	/** Total rendered height in pixels (useful in frame mode where the height is derived). */
	getHeight() {
		return this.height;
	}

	/** Forward pointer events from an element lying over/under the graph (used when the SVG has no pointer events). */
	pointerMove(e) {
		if (this._pointer) {
			this._pointer.move(e);
		}
	}

	pointerLeave() {
		if (this._pointer) {
			this._pointer.leave();
		}
	}

	_renderHeader() {
		const show = this.options.show_header && !this.options.frame;

		this.header.style.display = show ? '' : 'none';

		if (!show) {
			return;
		}

		const {time_from, time_to} = this.data;

		this.header.innerHTML = '';

		const title = document.createElement('span');
		title.className = 'eg-graph-title';
		title.textContent = this.options.title || '';

		const range = document.createElement('span');
		range.className = 'eg-graph-range';
		range.textContent = EnhancedGraph.formatDateTime(time_from) + '  -  ' + EnhancedGraph.formatDateTime(time_to);

		this.header.append(title, range);
	}

	_renderLegend() {
		this.legend.style.display = this.options.show_legend ? '' : 'none';

		if (!this.options.show_legend) {
			return;
		}

		const table = document.createElement('table');
		const thead = document.createElement('thead');
		const head_row = document.createElement('tr');

		for (const label of ['', 'Minimum', 'Maximum', 'Average', 'Last']) {
			const th = document.createElement('th');
			th.textContent = label;
			head_row.appendChild(th);
		}

		thead.appendChild(head_row);
		table.appendChild(thead);

		const tbody = document.createElement('tbody');

		this.data.series.forEach((s, i) => {
			const key = s.key ?? i;
			const tr = document.createElement('tr');

			if (this.hidden.has(key)) {
				tr.classList.add('eg-hidden');
			}

			const name_td = document.createElement('td');
			name_td.className = 'eg-graph-legend-name';

			const swatch = document.createElement('span');
			swatch.className = 'eg-graph-swatch';
			swatch.style.background = s.color;

			const label = document.createElement('span');
			label.textContent = (s.host ? s.host + ': ' : '') + s.name;
			label.title = label.textContent;

			name_td.append(swatch, label);
			tr.appendChild(name_td);

			for (const stat of ['min', 'max', 'avg', 'last']) {
				const td = document.createElement('td');
				td.textContent = EnhancedGraph.formatValue(s.stats[stat], s.units);
				tr.appendChild(td);
			}

			tr.addEventListener('click', () => {
				this.hidden.has(key) ? this.hidden.delete(key) : this.hidden.add(key);
				this.render();
			});

			tbody.appendChild(tr);
		});

		for (const trigger of this.data.triggers || []) {
			const tr = document.createElement('tr');
			tr.className = 'eg-legend-trigger';

			const name_td = document.createElement('td');
			name_td.className = 'eg-graph-legend-name';

			const swatch = document.createElement('span');
			swatch.className = 'eg-graph-swatch eg-swatch-trigger';
			swatch.style.borderTopColor = trigger.color;

			const label = document.createElement('span');
			label.textContent = trigger.name + ' ' + trigger.constant;
			label.title = label.textContent;

			name_td.append(swatch, label);
			tr.appendChild(name_td);

			const rest = document.createElement('td');
			rest.colSpan = 4;
			tr.appendChild(rest);
			tbody.appendChild(tr);
		}

		table.appendChild(tbody);

		this.legend.innerHTML = '';
		this.legend.appendChild(table);
	}

	_visibleSeries() {
		return this.data.series
			.map((s, i) => ({...s, _key: s.key ?? i}))
			.filter(s => !this.hidden.has(s._key) && s.points.length > 0);
	}

	_buildLayers(series) {
		// Returns [{series, axis, rows: [[t, y0, y1]]}] where y values are already signed (mirror => negative).
		// Series with a different unit than the first one go to the right axis.
		const type = this.data.graph_type || 'area';
		const left_units = series.length ? series[0].units : '';
		const axis_of = (s) => (s.axis === 0 || s.axis === 1) ? s.axis : (s.units === left_units ? 0 : 1);
		const draw_of = (s) => type === 'classic' ? (s.drawtype || 'line') : type === 'line' ? 'line' : 'area';
		const layers = [];

		if (type !== 'stacked') {
			for (const s of series) {
				const sign = s.mirror ? -1 : 1;
				layers.push({
					series: s,
					axis: axis_of(s),
					draw: draw_of(s),
					rows: s.points.map(([t, avg]) => [t, 0, avg === null ? null : sign * avg]),
					// calc "all" (classic min/avg/max): shaded min-max band plus min and max lines.
					band: s.calc === 'all'
						? s.points.map(([t, avg, min, max]) => [t, sign * (min ?? avg), avg === null ? null : sign * (max ?? avg)])
						: null
				});
			}

			// Filled series first (biggest first so smaller ones stay visible), lines on top in their own order.
			const filled = (l) => l.draw === 'area' || l.draw === 'gradient';
			const peak = (layer) => layer.rows.reduce((m, r) => r[2] === null ? m : Math.max(m, Math.abs(r[2])), 0);
			const areas = layers.filter(filled).sort((a, b) => peak(b) - peak(a));
			const lines = layers.filter(l => !filled(l));

			return [...areas, ...lines];
		}

		// Stacked: stack per axis, positive and mirrored series separately, aligned on the union of timestamps.
		for (const [axis, mirror] of [[0, false], [0, true], [1, false], [1, true]]) {
			const group = series.filter(s => !!s.mirror === mirror && axis_of(s) === axis);

			if (!group.length) {
				continue;
			}

			const times = [...new Set(group.flatMap(s => s.points.map(p => p[0])))].sort((a, b) => a - b);
			const base = new Map(times.map(t => [t, 0]));
			const sign = mirror ? -1 : 1;

			for (const s of group) {
				const lookup = new Map(s.points.map(p => [p[0], p[1]]));
				const rows = [];

				for (const t of times) {
					const v = lookup.get(t);
					const y0 = base.get(t);

					if (v === undefined || v === null) {
						rows.push([t, y0, null]);
						continue;
					}

					const y1 = y0 + sign * v;
					base.set(t, y1);
					rows.push([t, y0, y1]);
				}

				layers.push({series: s, axis, draw: 'area', rows});
			}
		}

		return layers;
	}

	_renderPlot(width, height) {
		for (const el of [...this.plot.children]) {
			if (el !== this.tooltip) {
				el.remove();
			}
		}

		const ns = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('width', width);
		svg.setAttribute('height', height);
		svg.classList.add('eg-graph-svg');

		const {time_from, time_to} = this.data;
		const series = this._visibleSeries();
		const layers = this._buildLayers(series);
		const axis_units = [
			(layers.find(l => l.axis === 0) || {series: series[0] || this.data.series[0] || {}}).series.units || '',
			(layers.find(l => l.axis === 1) || {series: {}}).series.units || ''
		];
		const has_right = layers.some(l => l.axis === 1);

		// Raw extents per axis.
		const ext = [{max: 0, min: 0}, {max: 0, min: 0}];

		for (const layer of layers) {
			for (const [, y0, y1] of layer.band ? layer.rows.concat(layer.band) : layer.rows) {
				if (y1 === null) {
					continue;
				}
				ext[layer.axis].max = Math.max(ext[layer.axis].max, y0, y1);
				ext[layer.axis].min = Math.min(ext[layer.axis].min, y0, y1);
			}
		}

		for (const e of ext) {
			if (e.max === 0 && e.min === 0) {
				e.max = 1;
			}
		}

		const frame = this.options.frame;
		const pad = frame
			? {top: frame.top, right: frame.right, bottom: EnhancedGraph.FRAME_BOTTOM, left: frame.left}
			: {top: 8, right: 14, bottom: 22, left: 10};
		const tick_count = Math.max(2, Math.floor((height - pad.top - pad.bottom) / 32));

		// Left axis: nice ticks.
		const step0 = EnhancedGraph.niceStep(ext[0].max - ext[0].min, tick_count);
		const scale = [{step: step0, max: Math.ceil(ext[0].max / step0) * step0, min: Math.floor(ext[0].min / step0) * step0}];

		// Right axis: same number of grid lines, zero on the same line, nice step that fits its data.
		if (has_right) {
			const n_up = Math.round(scale[0].max / step0);
			const n_down = Math.round(-scale[0].min / step0);
			let step1 = EnhancedGraph.niceCeil(Math.max(
				ext[1].max / Math.max(1, n_up),
				n_down > 0 ? -ext[1].min / n_down : 0
			));

			if (n_down === 0 && ext[1].min < 0) {
				step1 = EnhancedGraph.niceStep(ext[1].max - ext[1].min, tick_count);
			}

			scale.push({step: step1, max: n_up * step1, min: -n_down * step1});
		}

		// Fixed Y range from the graph definition (Zabbix "Y axis MIN/MAX value: Fixed").
		(this.data.axes || []).forEach((fixed, i) => {
			if (!scale[i] || !fixed || (fixed.min == null && fixed.max == null)) {
				return;
			}

			const min = fixed.min != null ? Number(fixed.min) : scale[i].min;
			const max = fixed.max != null ? Number(fixed.max) : scale[i].max;

			if (max > min) {
				scale[i] = {min, max, step: EnhancedGraph.niceStep(max - min, tick_count)};
			}
		});

		const ticksOf = (s) => {
			const out = [];
			for (let v = Math.ceil(s.min / s.step - 1e-9) * s.step; v <= s.max + s.step / 1e6; v += s.step) {
				out.push(Math.abs(v) < s.step / 1e6 ? 0 : v);
			}
			return out;
		};

		const y_ticks = ticksOf(scale[0]);
		const y_labels = y_ticks.map(v => EnhancedGraph.formatValue(Math.abs(v), axis_units[0]));
		const r_ticks = has_right ? ticksOf(scale[1]) : [];
		const r_labels = r_ticks.map(v => EnhancedGraph.formatValue(Math.abs(v), axis_units[1]));

		if (!frame) {
			pad.left = Math.max(...y_labels.map(l => l.length)) * 6.6 + 14;

			if (has_right) {
				pad.right = Math.max(...r_labels.map(l => l.length)) * 6.6 + 14;
			}
		}

		const pw = width - pad.left - pad.right;
		const ph = height - pad.top - pad.bottom;

		const x = (t) => pad.left + (t - time_from) / (time_to - time_from) * pw;
		const ys = scale.map(s => (v) => pad.top + (s.max - v) / (s.max - s.min) * ph);
		const y = ys[0];
		const units = axis_units[0];

		const el = (name, attrs, parent = svg) => {
			const node = document.createElementNS(ns, name);
			for (const [k, v] of Object.entries(attrs)) {
				node.setAttribute(k, v);
			}
			parent.appendChild(node);
			return node;
		};

		// Background + grid.
		el('rect', {x: pad.left, y: pad.top, width: pw, height: ph, class: 'eg-plot-bg'});

		// Working time: the whole plot is shaded as non-working, working intervals are cleared again.
		if (Array.isArray(this.data.work_periods)) {
			el('rect', {x: pad.left, y: pad.top, width: pw, height: ph, class: 'eg-nonwork'});

			for (const [start, end] of this.data.work_periods) {
				const x1 = Math.max(pad.left, pad.left + (start - time_from) / (time_to - time_from) * pw);
				const x2 = Math.min(pad.left + pw, pad.left + (end - time_from) / (time_to - time_from) * pw);

				if (x2 > x1) {
					el('rect', {x: x1, y: pad.top, width: x2 - x1, height: ph, class: 'eg-work'});
				}
			}
		}

		// In frame mode the title sits in the top margin, like on the classic image.
		if (frame && this.options.title) {
			const title = el('text', {
				x: pad.left + pw / 2, y: Math.max(12, pad.top / 2 + 4), class: 'eg-title', 'text-anchor': 'middle'
			});
			title.textContent = this.options.title;
		}

		y_ticks.forEach((v, i) => {
			const yy = Math.round(y(v)) + 0.5;
			el('line', {x1: pad.left, x2: pad.left + pw, y1: yy, y2: yy, class: v === 0 ? 'eg-zero' : 'eg-grid'});
			const text = el('text', {x: pad.left - 6, y: yy + 4, class: 'eg-axis-label', 'text-anchor': 'end'});
			text.textContent = y_labels[i];
		});

		r_ticks.forEach((v, i) => {
			const yy = Math.round(ys[1](v)) + 0.5;
			const text = el('text', {x: pad.left + pw + 6, y: yy + 4, class: 'eg-axis-label', 'text-anchor': 'start'});
			text.textContent = r_labels[i];
		});

		const t_ticks = EnhancedGraph.timeTicks(time_from, time_to, Math.max(2, Math.floor(pw / 90)));

		for (const t of t_ticks) {
			const xx = Math.round(x(t)) + 0.5;
			el('line', {x1: xx, x2: xx, y1: pad.top, y2: pad.top + ph, class: 'eg-grid'});
			const text = el('text', {x: xx, y: height - 6, class: 'eg-axis-label', 'text-anchor': 'middle'});
			text.textContent = EnhancedGraph.formatTime(t, time_to - time_from);
		}

		// Series.
		const uid = Math.random().toString(36).slice(2);
		const clip_id = 'eg-clip-' + uid;
		const defs = el('defs', {});
		const clip = el('clipPath', {id: clip_id}, defs);
		el('rect', {x: pad.left, y: pad.top, width: pw, height: ph}, clip);

		const g = el('g', {'clip-path': `url(#${clip_id})`});

		layers.forEach((layer, li) => {
			const segments = EnhancedGraph._segments(layer.rows, layer.series.max_gap);
			const y = ys[layer.axis];

			if (layer.band) {
				for (const seg of EnhancedGraph._segments(layer.band, layer.series.max_gap)) {
					if (seg.length < 2) {
						continue;
					}

					const hi = seg.map(([t, , mx]) => `${x(t).toFixed(1)},${y(mx).toFixed(1)}`);
					const lo = seg.map(([t, mn]) => `${x(t).toFixed(1)},${y(mn).toFixed(1)}`);

					el('polygon', {points: hi.concat(lo.slice().reverse()).join(' '), fill: layer.series.color,
						class: 'eg-band'}, g);
					el('polyline', {points: hi.join(' '), stroke: layer.series.color, class: 'eg-band-line'}, g);
					el('polyline', {points: lo.join(' '), stroke: layer.series.color, class: 'eg-band-line'}, g);
				}
			}
			const draw = layer.draw || 'area';
			let fill = layer.series.color;

			if (draw === 'gradient') {
				const grad_id = `eg-grad-${uid}-${li}`;
				const grad = el('linearGradient', {id: grad_id, x1: 0, y1: 0, x2: 0, y2: 1}, defs);
				el('stop', {offset: '0%', 'stop-color': layer.series.color, 'stop-opacity': 0.85}, grad);
				el('stop', {offset: '100%', 'stop-color': layer.series.color, 'stop-opacity': 0.3}, grad);
				fill = `url(#${grad_id})`;
			}

			for (const seg of segments) {
				// A lone value between gaps: draw a dot, like the classic graph.
				if (seg.length === 1) {
					const [t, , y1] = seg[0];
					el('circle', {cx: x(t).toFixed(1), cy: y(y1).toFixed(1), r: 2.2, fill: layer.series.color}, g);
					continue;
				}

				const top = seg.map(([t, , y1]) => `${x(t).toFixed(1)},${y(y1).toFixed(1)}`);

				if (draw === 'area' || draw === 'gradient') {
					const bottom = seg.slice().reverse().map(([t, y0]) => `${x(t).toFixed(1)},${y(y0).toFixed(1)}`);
					el('polygon', {
						points: top.concat(bottom).join(' '),
						fill,
						class: draw === 'gradient' ? 'eg-area eg-area-gradient' : 'eg-area'
					}, g);
					el('polyline', {points: top.join(' '), stroke: layer.series.color, class: 'eg-line'}, g);
				}
				else {
					el('polyline', {
						points: top.join(' '),
						stroke: layer.series.color,
						class: 'eg-line eg-line-only eg-draw-' + draw
					}, g);
				}
			}
		});

		for (const trigger of this.data.triggers || []) {
			const sc = scale[trigger.axis] || scale[0];
			const ty = (ys[trigger.axis] || ys[0])(trigger.value);

			if (trigger.value <= sc.min || trigger.value >= sc.max) {
				continue;
			}

			el('line', {x1: pad.left, x2: pad.left + pw, y1: ty.toFixed(1), y2: ty.toFixed(1), stroke: trigger.color,
				class: 'eg-trigger'});
		}

		// Frame on top.
		el('rect', {x: pad.left + 0.5, y: pad.top + 0.5, width: pw - 1, height: ph - 1, class: 'eg-frame'});

		// Hover crosshair.
		const cross = el('line', {x1: 0, x2: 0, y1: pad.top, y2: pad.top + ph, class: 'eg-cross'});
		cross.style.display = 'none';

		// Zoom selection box.
		const sbox = el('rect', {x: 0, y: pad.top, width: 0, height: ph, class: 'eg-sbox'});
		const stxt = el('text', {x: 0, y: pad.top + 14, class: 'eg-sbox-text'});
		sbox.style.display = 'none';
		stxt.style.display = 'none';

		const period = time_to - time_from;
		const spp = period / pw; // seconds per pixel
		const clampX = (mx) => Math.max(pad.left, Math.min(pad.left + pw, mx));
		const drag = {active: false, moved: false, start: 0, end: 0};

		const mouseX = (e) => e.clientX - svg.getBoundingClientRect().left;

		const onMove = (e) => {
			const mx = mouseX(e);

			if (drag.active) {
				drag.end = clampX(mx);

				if (!drag.moved && Math.abs(drag.end - drag.start) > 2) {
					drag.moved = true;
					this._hideHover(cross);

					if (this.options.onDragStart) {
						this.options.onDragStart();
					}
				}

				if (drag.moved) {
					const left = Math.min(drag.start, drag.end);
					const seconds = Math.round(Math.abs(drag.end - drag.start) * spp);

					sbox.setAttribute('x', left);
					sbox.setAttribute('width', Math.abs(drag.end - drag.start));
					sbox.style.display = '';

					stxt.textContent = EnhancedGraph.formatDuration(seconds)
						+ (seconds < this.options.min_period ? ' [min 1m]' : '');
					stxt.setAttribute('x', left + 5);
					stxt.style.display = '';
				}

				return;
			}

			if (mx < pad.left || mx > pad.left + pw || !layers.length) {
				this._hideHover(cross);
				return;
			}

			const t = time_from + (mx - pad.left) / pw * period;
			this._showHover(cross, x, t, mx, e.clientY - svg.getBoundingClientRect().top, layers, units);
		};

		const onUp = () => {
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);

			if (!drag.active) {
				return;
			}

			drag.active = false;
			sbox.style.display = 'none';
			stxt.style.display = 'none';

			if (!drag.moved) {
				return;
			}

			const lo = Math.min(drag.start, drag.end) - pad.left;
			const hi = Math.max(drag.start, drag.end) - pad.left;
			const seconds = Math.round((hi - lo) * spp);
			const from_offset = Math.max(0, Math.ceil(Math.floor(lo) * spp));
			const to_offset = Math.max(0, Math.ceil(Math.floor(pw - hi) * spp));

			if (seconds > this.options.min_period && (from_offset > 0 || to_offset > 0) && this.options.onZoom) {
				this.options.onZoom({from_offset, to_offset});
			}
			else if (this.options.onDragEnd) {
				this.options.onDragEnd();
			}
		};

		this._pointer = {
			move: (e) => {
				if (!drag.active) {
					onMove(e);
				}
			},
			leave: () => {
				if (!drag.active) {
					this._hideHover(cross);
				}
			}
		};

		svg.addEventListener('mousemove', this._pointer.move);
		svg.addEventListener('mouseleave', this._pointer.leave);

		if (this.options.zoomable) {
			svg.classList.add('eg-zoomable');

			svg.addEventListener('mousedown', (e) => {
				const mx = mouseX(e);

				if (e.button !== 0 || mx < pad.left || mx > pad.left + pw) {
					return;
				}

				e.preventDefault();
				drag.active = true;
				drag.moved = false;
				drag.start = drag.end = clampX(mx);

				document.addEventListener('mousemove', onMove);
				document.addEventListener('mouseup', onUp);
			});

			svg.addEventListener('dblclick', (e) => {
				e.preventDefault();

				if (this.options.onZoomOut) {
					this.options.onZoomOut();
				}
			});
		}

		this.plot.insertBefore(svg, this.tooltip);

		if (!series.length) {
			const msg = document.createElement('div');
			msg.className = 'eg-graph-nodata';
			msg.textContent = 'No data';
			this.plot.insertBefore(msg, this.tooltip);
		}
	}

	static _segments(rows, max_gap) {
		// Split into continuous segments; break on nulls and on gaps longer than max_gap seconds.
		// max_gap: number = limit from the server (classic Zabbix rule), null = never break on gaps,
		// undefined = estimate (3x the typical step).
		let limit = Infinity;

		if (typeof max_gap === 'number' && max_gap > 0) {
			limit = max_gap;
		}
		else if (max_gap === undefined) {
			const deltas = [];

			for (let i = 1; i < rows.length; i++) {
				deltas.push(rows[i][0] - rows[i - 1][0]);
			}

			deltas.sort((a, b) => a - b);
			limit = deltas.length ? deltas[Math.floor(deltas.length / 2)] * 3 : Infinity;
		}

		const segments = [];
		let current = [];

		rows.forEach((row, i) => {
			const gap = i > 0 && row[0] - rows[i - 1][0] > limit;

			if (row[2] === null || gap) {
				if (current.length) {
					segments.push(current);
				}
				current = [];
			}

			if (row[2] !== null) {
				current.push(row);
			}
		});

		if (current.length) {
			segments.push(current);
		}

		return segments;
	}

	_showHover(cross, x, t, mx, my, layers, units) {
		const rows = [];
		let snap_t = null;

		for (const layer of layers) {
			let best = null;

			for (const row of layer.rows) {
				if (row[2] === null) {
					continue;
				}
				if (best === null || Math.abs(row[0] - t) < Math.abs(best[0] - t)) {
					best = row;
				}
			}

			if (best !== null) {
				snap_t = snap_t === null || Math.abs(best[0] - t) < Math.abs(snap_t - t) ? best[0] : snap_t;
				const band = layer.band ? layer.band.find(r => r[0] === best[0]) : null;
				rows.push({series: layer.series, value: Math.abs(best[2] - best[1]),
					range: band ? [Math.abs(band[1]), Math.abs(band[2])] : null});
			}
		}

		if (snap_t === null) {
			this._hideHover(cross);
			return;
		}

		const cx = Math.round(x(snap_t)) + 0.5;
		cross.setAttribute('x1', cx);
		cross.setAttribute('x2', cx);
		cross.style.display = '';

		this.tooltip.innerHTML = '';

		const time = document.createElement('div');
		time.className = 'eg-tt-time';
		time.textContent = EnhancedGraph.formatDateTime(snap_t);
		this.tooltip.appendChild(time);

		for (const {series, value, range} of rows) {
			const line = document.createElement('div');
			line.className = 'eg-tt-row';

			const swatch = document.createElement('span');
			swatch.className = 'eg-graph-swatch';
			swatch.style.background = series.color;

			const name = document.createElement('span');
			name.className = 'eg-tt-name';
			name.textContent = series.name;

			const val = document.createElement('span');
			val.className = 'eg-tt-value';
			val.textContent = EnhancedGraph.formatValue(value, series.units || units)
				+ (range ? '  (' + EnhancedGraph.formatValue(range[0], series.units || units) + ' - '
					+ EnhancedGraph.formatValue(range[1], series.units || units) + ')' : '');

			line.append(swatch, name, val);
			this.tooltip.appendChild(line);
		}

		this.tooltip.style.display = 'block';

		const tw = this.tooltip.offsetWidth;
		const left = mx + 14 + tw > this.width ? mx - 14 - tw : mx + 14;

		this.tooltip.style.left = Math.max(0, left) + 'px';
		this.tooltip.style.top = Math.max(0, my - 10) + 'px';
	}

	_hideHover(cross) {
		cross.style.display = 'none';
		this.tooltip.style.display = 'none';
	}

	getSVGElement() {
		return this.plot.querySelector('svg');
	}
}

EnhancedGraph.CSS = `
.eg-graph {
	--eg-bg: #ffffff;
	--eg-plot-bg: #ffffff;
	--eg-nonwork: #eef1f4;
	--eg-grid: #e3e6e8;
	--eg-zero: #8a9299;
	--eg-frame: #c5cace;
	--eg-text: #1e262e;
	--eg-muted: #6b7681;
	--eg-legend-head: #f3f4f5;
	--eg-legend-row: #ffffff;
	--eg-legend-alt: #f8f9fa;
	--eg-legend-hover: #eef2f5;
	--eg-tt-bg: rgba(255, 255, 255, 0.97);
	--eg-tt-border: #c5cace;
	--eg-area-opacity: 0.85;

	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	background: var(--eg-bg);
	color: var(--eg-text);
	font-family: "Roboto", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
	font-size: 11px;
	overflow: hidden;
	position: relative;
}
.eg-graph[data-theme="dark"] {
	--eg-bg: #1e262e;
	--eg-plot-bg: #232c35;
	--eg-nonwork: #1a2128;
	--eg-grid: #33404b;
	--eg-zero: #8c99a5;
	--eg-frame: #3b4955;
	--eg-text: #e1e6ea;
	--eg-muted: #95a3af;
	--eg-legend-head: #26313b;
	--eg-legend-row: #1e262e;
	--eg-legend-alt: #222b34;
	--eg-legend-hover: #2b3742;
	--eg-tt-bg: rgba(30, 38, 46, 0.97);
	--eg-tt-border: #4a5864;
	--eg-area-opacity: 0.8;
}
.eg-graph-header {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	padding: 4px 8px 4px 8px;
	gap: 12px;
	flex: 0 0 auto;
}
.eg-graph-title {
	font-weight: 600;
	font-size: 12px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.eg-graph-range {
	color: var(--eg-muted);
	font-size: 10px;
	white-space: nowrap;
}
.eg-graph-plot {
	position: relative;
	flex: 0 0 auto;
}
.eg-graph-svg {
	display: block;
}
.eg-graph-svg .eg-plot-bg { fill: var(--eg-plot-bg); }
.eg-graph-svg .eg-nonwork { fill: var(--eg-nonwork); }
.eg-graph-svg .eg-work { fill: var(--eg-plot-bg); }
.eg-graph-svg .eg-title { fill: var(--eg-text); font-size: 12px; font-weight: 600; font-family: inherit; }
.eg-graph-svg .eg-draw-bold { stroke-width: 3; }
.eg-graph-svg .eg-draw-dashed { stroke-dasharray: 6 4; }
.eg-graph-svg .eg-draw-dot { stroke-width: 2.5; stroke-dasharray: 0.5 4; stroke-linecap: round; }
.eg-graph-svg .eg-area-gradient { opacity: 1; }
.eg-graph-svg .eg-grid { stroke: var(--eg-grid); stroke-width: 1; shape-rendering: crispEdges; }
.eg-graph-svg .eg-zero { stroke: var(--eg-zero); stroke-width: 1; shape-rendering: crispEdges; }
.eg-graph-svg .eg-frame { fill: none; stroke: var(--eg-frame); stroke-width: 1; shape-rendering: crispEdges; }
.eg-graph-svg .eg-axis-label { fill: var(--eg-muted); font-size: 10px; font-family: inherit; }
.eg-graph-svg .eg-area { opacity: var(--eg-area-opacity); stroke: none; }
.eg-graph-svg .eg-band { opacity: 0.18; stroke: none; }
.eg-graph-svg .eg-trigger { stroke-width: 1.5; stroke-dasharray: 6 4; fill: none; }
.eg-graph-legend tbody tr.eg-legend-trigger { cursor: default; }
.eg-graph-swatch.eg-swatch-trigger { background: transparent !important; height: 0; border-top: 2px dashed; vertical-align: 3px; }
.eg-graph-svg .eg-band-line { fill: none; stroke-width: 1; opacity: 0.55; stroke-linejoin: round; }
.eg-graph-svg .eg-line { fill: none; stroke-width: 1.2; stroke-linejoin: round; }
.eg-graph-svg .eg-line-only { stroke-width: 1.6; filter: none; }
.eg-graph-svg .eg-cross { stroke: var(--eg-text); stroke-width: 1; stroke-dasharray: 3 2; opacity: 0.6; }
.eg-graph-svg.eg-zoomable { cursor: crosshair; user-select: none; }
.eg-graph-svg .eg-sbox { fill: #1e90ff; fill-opacity: 0.15; stroke: #1e90ff; stroke-width: 1; pointer-events: none; }
.eg-graph-svg .eg-sbox-text { fill: var(--eg-text); font-size: 11px; font-weight: 600; pointer-events: none; }
.eg-graph-nodata {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	color: var(--eg-muted);
	font-size: 13px;
	pointer-events: none;
}
.eg-graph-legend {
	flex: 0 0 auto;
	max-height: 45%;
	overflow-y: auto;
	padding: 2px 8px 6px 8px;
}
.eg-graph[data-frame] .eg-graph-legend {
	max-height: none;
}
.eg-graph-legend table {
	width: 100%;
	border-collapse: collapse;
	font-variant-numeric: tabular-nums;
}
.eg-graph-legend th {
	background: var(--eg-legend-head);
	color: var(--eg-muted);
	font-weight: 600;
	font-size: 10px;
	text-transform: uppercase;
	letter-spacing: 0.03em;
	text-align: right;
	padding: 3px 8px;
	position: sticky;
	top: 0;
}
.eg-graph-legend th:first-child { text-align: left; }
.eg-graph-legend td {
	padding: 2px 8px;
	text-align: right;
	white-space: nowrap;
	border-bottom: 1px solid var(--eg-grid);
}
.eg-graph-legend tbody tr { background: var(--eg-legend-row); cursor: pointer; }
.eg-graph-legend tbody tr:nth-child(even) { background: var(--eg-legend-alt); }
.eg-graph-legend tbody tr:hover { background: var(--eg-legend-hover); }
.eg-graph-legend tbody tr.eg-hidden { opacity: 0.4; }
.eg-graph-legend tbody tr.eg-hidden .eg-graph-swatch { background: transparent !important; outline: 1px solid var(--eg-muted); }
.eg-graph-legend-name {
	text-align: left !important;
	max-width: 1px;
	width: 100%;
	overflow: hidden;
	text-overflow: ellipsis;
}
.eg-graph-swatch {
	display: inline-block;
	width: 10px;
	height: 10px;
	margin-right: 6px;
	vertical-align: -1px;
	border-radius: 1px;
}
.eg-graph-tooltip {
	display: none;
	position: absolute;
	z-index: 10;
	pointer-events: none;
	background: var(--eg-tt-bg);
	border: 1px solid var(--eg-tt-border);
	border-radius: 3px;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
	padding: 5px 8px;
	font-size: 11px;
	min-width: 160px;
	font-variant-numeric: tabular-nums;
}
.eg-tt-time { color: var(--eg-muted); margin-bottom: 3px; }
.eg-tt-row { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.eg-tt-name { flex: 1 1 auto; margin-right: 10px; }
.eg-tt-value { font-weight: 600; }
`;

if (typeof window !== 'undefined') {
	window.EnhancedGraph = EnhancedGraph;
}
