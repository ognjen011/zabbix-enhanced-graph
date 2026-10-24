<?php declare(strict_types = 0);


namespace Modules\EnhancedGraph\Actions;

use API,
	CArrayHelper,
	CController,
	CControllerResponseData,
	CHousekeepingHelper,
	CMacrosResolverHelper,
	CNumberParser,
	CParser,
	CSeverityHelper,
	CRangeTimeParser,
	CSettingsHelper,
	CSimpleIntervalParser,
	Manager;

/**
 * Read-only data source for the Enhanced graph theme.
 *
 * Given the same parameters as a classic graph image (chart2.php?graphid=... or chart.php?itemids[]=...), returns
 * the graph definition and aggregated history/trend values as JSON. Uses only API get calls and the same history
 * aggregation function as the built-in graphs, so it respects user permissions and never writes anything.
 */
class GraphData extends CController {

	// Never send more than this many points per series to the browser.
	private const POINTS_MAX = 2000;

	// Same as the classic graph: no working time shading for periods over 3 months.
	private const WORK_PERIOD_MAX = SEC_PER_MONTH * 3;

	private const DRAWTYPES = [
		DRAWTYPE_LINE => 'line',
		DRAWTYPE_FILLED_REGION => 'area',
		DRAWTYPE_BOLD_LINE => 'bold',
		DRAWTYPE_DOT => 'dot',
		DRAWTYPE_DASHED_LINE => 'dashed',
		DRAWTYPE_GRADIENT_LINE => 'gradient',
		DRAWTYPE_BOLD_DOT => 'dot'
	];

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		$ret = $this->validateInput([
			'graphid' =>	'db graphs.graphid',
			'itemids' =>	'array_db items.itemid',
			'from' =>		'required|string',
			'to' =>			'required|string',
			'width' =>		'int32|ge 1|le 65535',
			'batch' =>		'in 1'
		]);

		if ($ret && !$this->hasInput('graphid') && !$this->hasInput('itemids')) {
			$ret = false;
		}

		if (!$ret) {
			$this->respond(['error' => 'invalid request']);
		}

		return $ret;
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() >= USER_TYPE_ZABBIX_USER;
	}

	protected function doAction(): void {
		$parser = new CRangeTimeParser();

		if ($parser->parse($this->getInput('from')) != CParser::PARSE_SUCCESS) {
			$this->respond(['error' => 'invalid time period']);

			return;
		}
		$time_from = $parser->getDateTime(true)->getTimestamp();

		if ($parser->parse($this->getInput('to')) != CParser::PARSE_SUCCESS) {
			$this->respond(['error' => 'invalid time period']);

			return;
		}
		$time_to = $parser->getDateTime(false)->getTimestamp();

		if ($time_to <= $time_from) {
			$this->respond(['error' => 'invalid time period']);

			return;
		}

		$width = max(50, min(self::POINTS_MAX, (int) $this->getInput('width', 1000)));

		$result = $this->hasInput('graphid')
			? $this->getGraph((string) $this->getInput('graphid'))
			: $this->getAdHoc($this->getInput('itemids'));

		if ($result === null) {
			// Unknown graph, no permissions, or a graph type we do not redraw (pie): keep the classic image.
			$this->respond(['skip' => true]);

			return;
		}

		[$definition, $items] = $result;

		$this->resolveDataSource($items, $time_from, $time_to, $width);

		$history = Manager::History()->getGraphAggregationByWidth(
			array_map(static fn(array $item): array => [
				'itemid' => $item['itemid'],
				'value_type' => $item['value_type'],
				'source' => $item['source']
			], array_values($items)),
			$time_from, $time_to, $width
		);

		$series = [];

		foreach ($definition['series'] as $graph_item) {
			$item = $items[$graph_item['itemid']] ?? null;

			if ($item === null) {
				continue;
			}

			$value_field = $graph_item['calc'];
			$points = [];
			$min = null;
			$max = null;
			$sum = 0;
			$count = 0;

			foreach ($history[$item['itemid']]['data'] ?? [] as $row) {
				$avg = (float) $row['avg'];
				$row_min = (float) $row['min'];
				$row_max = (float) $row['max'];
				$value = $value_field === 'min' ? $row_min : ($value_field === 'max' ? $row_max : $avg);

				$points[] = [(int) $row['clock'], $value, $row_min, $row_max];

				$min = $min === null ? $row_min : min($min, $row_min);
				$max = $max === null ? $row_max : max($max, $row_max);
				$sum += $avg;
				$count++;
			}

			usort($points, static fn(array $a, array $b): int => $a[0] <=> $b[0]);

			$series[] = [
				'key' => $graph_item['key'],
				'name' => $item['name'],
				'host' => $definition['multi_host'] ? $item['hosts'][0]['name'] : '',
				'units' => $item['units'],
				'color' => $graph_item['color'],
				'axis' => $graph_item['axis'],
				'drawtype' => $graph_item['drawtype'],
				'calc' => $graph_item['calc'],
				'max_gap' => self::maxGap($item, $time_from, $time_to, $width),
				'points' => $points,
				'stats' => [
					'min' => $min,
					'max' => $max,
					'avg' => $count > 0 ? $sum / $count : null,
					'last' => $points ? $points[count($points) - 1][1] : null
				]
			];
		}

		$this->respond([
			'title' => $definition['title'],
			'time_from' => $time_from,
			'time_to' => $time_to,
			'graph_type' => $definition['graph_type'],
			'axes' => $definition['axes'],
			'show_legend' => $definition['show_legend'],
			'work_periods' => $definition['show_work_period']
				? self::getWorkPeriods($time_from, $time_to)
				: null,
			'triggers' => $definition['show_triggers'] ? self::getTriggers($definition['series']) : [],
			'series' => $series
		]);
	}

	/**
	 * Graph defined in Zabbix (chart2.php?graphid=...). Pie / exploded graphs are left classic.
	 */
	private function getGraph(string $graphid): ?array {
		$graphs = API::Graph()->get([
			'output' => ['graphid', 'name', 'graphtype', 'show_legend', 'show_work_period', 'show_triggers', 'ymin_type',
				'ymax_type', 'yaxismin', 'yaxismax', 'ymin_itemid', 'ymax_itemid'
			],
			'selectGraphItems' => ['gitemid', 'itemid', 'color', 'drawtype', 'yaxisside', 'calc_fnc', 'sortorder'],
			'selectHosts' => ['name'],
			'graphids' => [$graphid]
		]);

		if (!$graphs) {
			return null;
		}

		$graph = $graphs[0];

		if ($graph['graphtype'] != GRAPH_TYPE_NORMAL && $graph['graphtype'] != GRAPH_TYPE_STACKED) {
			return null;
		}

		$items = $this->getItems(array_column($graph['gitems'], 'itemid'));

		if (!$items) {
			return null;
		}

		$graph = CMacrosResolverHelper::resolveGraphNameByIds([$graph])[0];

		$gitems = $graph['gitems'];
		CArrayHelper::sort($gitems, ['sortorder']);

		$series = [];

		foreach ($gitems as $gitem) {
			$series[] = [
				'key' => $gitem['gitemid'],
				'itemid' => $gitem['itemid'],
				'color' => '#'.$gitem['color'],
				'axis' => $gitem['yaxisside'] == GRAPH_YAXIS_SIDE_RIGHT ? 1 : 0,
				'drawtype' => self::DRAWTYPES[$gitem['drawtype']] ?? 'line',
				'calc' => [CALC_FNC_MIN => 'min', CALC_FNC_MAX => 'max', CALC_FNC_ALL => 'all'][$gitem['calc_fnc']]
					?? 'avg'
			];
		}

		$host_names = array_unique(array_column($graph['hosts'], 'name'));

		$y_min = self::axisLimit($graph['ymin_type'], $graph['yaxismin'], $graph['ymin_itemid']);
		$y_max = self::axisLimit($graph['ymax_type'], $graph['yaxismax'], $graph['ymax_itemid']);

		return [[
			'title' => (count($host_names) == 1 ? reset($host_names).NAME_DELIMITER : '').$graph['name'],
			'graph_type' => $graph['graphtype'] == GRAPH_TYPE_STACKED ? 'stacked' : 'classic',
			'show_legend' => $graph['show_legend'] == 1,
			'show_work_period' => $graph['show_work_period'] == 1,
			'show_triggers' => $graph['show_triggers'] == 1,
			'multi_host' => count($host_names) > 1,
			'axes' => [['min' => $y_min, 'max' => $y_max], ['min' => $y_min, 'max' => $y_max]],
			'series' => $series
		], $items];
	}

	/**
	 * Ad-hoc item graph (chart.php?itemids[]=..., e.g. Latest data > Graph). Shows working time like the classic one.
	 */
	private function getAdHoc(array $itemids): ?array {
		$items = $this->getItems($itemids);

		if (!$items) {
			return null;
		}

		$series = [];

		foreach (array_values($items) as $i => $item) {
			$series[] = [
				'key' => $item['itemid'],
				'itemid' => $item['itemid'],
				'color' => null,
				'axis' => null,
				// Same as the classic simple graph: min/avg/max ("all"), or only avg for batch graphs.
				'drawtype' => $this->hasInput('batch') ? 'area' : 'line',
				'calc' => $this->hasInput('batch') ? 'avg' : 'all'
			];
		}

		$host_names = array_unique(array_map(static fn(array $item): string => $item['hosts'][0]['name'], $items));
		$first = reset($items);

		return [[
			'title' => count($items) == 1
				? $first['hosts'][0]['name'].NAME_DELIMITER.$first['name']
				: (count($host_names) == 1 ? reset($host_names) : ''),
			'graph_type' => 'classic',
			'show_legend' => true,
			'show_work_period' => true,
			// The classic simple graph shows trigger lines, except for multi-item "batch" graphs.
			'show_triggers' => !$this->hasInput('batch'),
			'multi_host' => count($host_names) > 1,
			'axes' => [],
			'series' => $series
		], $items];
	}

	private function getItems(array $itemids): array {
		$items = API::Item()->get([
			'output' => ['itemid', 'hostid', 'name_resolved', 'value_type', 'units', 'history', 'trends', 'delay'],
			'selectHosts' => ['name'],
			'itemids' => $itemids,
			'filter' => [
				'value_type' => [ITEM_VALUE_TYPE_FLOAT, ITEM_VALUE_TYPE_UINT64]
			],
			'webitems' => true,
			'preservekeys' => true
		]);

		return CArrayHelper::renameObjectsKeys($items, ['name_resolved' => 'name']);
	}

	/**
	 * Decide per item whether history or trends are read (same rule as the built-in graphs).
	 */
	private function resolveDataSource(array &$items, int $time_from, int $time_to, int $width): void {
		$history_global = CHousekeepingHelper::get(CHousekeepingHelper::HK_HISTORY_GLOBAL);
		$trends_global = CHousekeepingHelper::get(CHousekeepingHelper::HK_TRENDS_GLOBAL);

		$to_resolve = ['delay'];

		if (!$history_global) {
			$to_resolve[] = 'history';
		}

		if (!$trends_global) {
			$to_resolve[] = 'trends';
		}

		$items = CMacrosResolverHelper::resolveTimeUnitMacros($items, $to_resolve);

		$parser = new CSimpleIntervalParser();
		$period = max(1, $time_to - $time_from);

		foreach ($items as &$item) {
			if ($history_global) {
				$history = $item['history'] != 0
					? timeUnitToSeconds(CHousekeepingHelper::get(CHousekeepingHelper::HK_HISTORY))
					: 0;
			}
			else {
				$history = $parser->parse($item['history']) == CParser::PARSE_SUCCESS
					? timeUnitToSeconds($item['history'])
					: 0;
			}

			if ($trends_global) {
				$trends = $item['trends'] != 0
					? timeUnitToSeconds(CHousekeepingHelper::get(CHousekeepingHelper::HK_TRENDS))
					: 0;
			}
			else {
				$trends = $parser->parse($item['trends']) == CParser::PARSE_SUCCESS
					? timeUnitToSeconds($item['trends'])
					: 0;
			}

			$item['source'] = ($trends == 0 || (time() - $history < $time_from
					&& $period / $width <= ZBX_MAX_TREND_DIFF / ZBX_GRAPH_MAX_SKIP_CELL))
				? 'history'
				: 'trends';
		}
		unset($item);
	}

	/**
	 * Y axis limit: fixed value, or the last value of an item (same as chart2.php / CLineGraphDraw).
	 */
	private static function axisLimit($type, $fixed, $itemid): ?float {
		if ($type == GRAPH_YAXIS_TYPE_FIXED) {
			return (float) $fixed;
		}

		if ($type == GRAPH_YAXIS_TYPE_ITEM_VALUE && $itemid != 0) {
			$items = API::Item()->get([
				'output' => ['itemid', 'value_type'],
				'itemids' => [$itemid],
				'filter' => ['value_type' => [ITEM_VALUE_TYPE_FLOAT, ITEM_VALUE_TYPE_UINT64]],
				'webitems' => true
			]);

			if ($items) {
				$history = Manager::History()->getLastValues($items);

				if ($history) {
					return (float) $history[$items[0]['itemid']][0]['value'];
				}
			}
		}

		return null;
	}

	/**
	 * Trigger threshold lines, same selection as the classic graph (CLineGraphDraw::selectTriggers): at most 3,
	 * enabled triggers with a single last/min/avg/max function on a graph item compared to a constant.
	 */
	private static function getTriggers(array $graph_items): array {
		$number_parser = new CNumberParser(['with_size_suffix' => true, 'with_time_suffix' => true]);
		$max = 3;
		$result = [];

		foreach ($graph_items as $graph_item) {
			if (count($result) >= $max) {
				break;
			}

			$db_triggers = DBselect(
				'SELECT DISTINCT h.host,tr.description,tr.triggerid,tr.expression,tr.priority,tr.value'.
				' FROM triggers tr,functions f,items i,hosts h'.
				' WHERE tr.triggerid=f.triggerid'.
					" AND f.name IN ('last','min','avg','max')".
					' AND tr.status='.TRIGGER_STATUS_ENABLED.
					' AND i.itemid=f.itemid'.
					' AND h.hostid=i.hostid'.
					' AND f.itemid='.zbx_dbstr($graph_item['itemid']).
				' ORDER BY tr.priority'
			);

			while (($trigger = DBfetch($db_triggers)) && count($result) < $max) {
				$fnc_cnt = DBfetch(DBselect(
					'SELECT COUNT(*) AS cnt FROM functions f WHERE f.triggerid='.zbx_dbstr($trigger['triggerid'])
				));

				if ($fnc_cnt['cnt'] != 1) {
					continue;
				}

				$trigger['expression'] = CMacrosResolverHelper::resolveTriggerExpressions([$trigger],
					['resolve_usermacros' => true, 'resolve_functionids' => false]
				)[0]['expression'];

				if (!preg_match('/^\{\d+\}\s*(?<operator>[><]=?|=)\s*(?<constant>.*)$/', $trigger['expression'],
						$matches)) {
					continue;
				}

				if ($number_parser->parse($matches['constant']) != CParser::PARSE_SUCCESS) {
					continue;
				}

				$result[] = [
					'axis' => $graph_item['axis'] ?? 0,
					'value' => (float) $number_parser->calcValue(),
					'color' => '#'.CSeverityHelper::getColor((int) $trigger['priority']),
					'name' => _('Trigger').NAME_DELIMITER.CMacrosResolverHelper::resolveTriggerName($trigger),
					'constant' => '['.$matches['operator'].' '.$matches['constant'].']'
				];
			}
		}

		return $result;
	}

	/**
	 * Longest gap (seconds) that is still drawn as a connected line, same rule as the classic graph
	 * (CLineGraphDraw): 4x the item update interval, or 16 pixels' worth of time when a pixel spans more than
	 * one interval. Trends count as hourly. Null = always connect (no fixed interval, e.g. trapper items).
	 */
	private static function maxGap(array $item, int $time_from, int $time_to, int $width): ?int {
		$delay = explode(';', (string) $item['delay'])[0];
		$delay = $delay !== '' ? timeUnitToSeconds($delay) : null;

		if ($delay === null || $delay <= 0) {
			return null;
		}

		if ($item['source'] === 'trends') {
			$delay = max($delay, ZBX_MAX_TREND_DIFF);
		}

		$cell = ($time_to - $time_from) / max(1, $width);

		return (int) ceil($cell > $delay ? ZBX_GRAPH_MAX_SKIP_CELL * $cell : ZBX_GRAPH_MAX_SKIP_DELAY * $delay);
	}

	/**
	 * Working time intervals within the period, computed exactly like the classic graph (CLineGraphDraw).
	 */
	private static function getWorkPeriods(int $time_from, int $time_to): ?array {
		if ($time_to - $time_from > self::WORK_PERIOD_MAX) {
			return null;
		}

		$config = [CSettingsHelper::WORK_PERIOD => CSettingsHelper::get(CSettingsHelper::WORK_PERIOD)];
		$config = CMacrosResolverHelper::resolveTimeUnitMacros([$config], [CSettingsHelper::WORK_PERIOD])[0];

		$periods = parse_period($config[CSettingsHelper::WORK_PERIOD]);

		if (!$periods) {
			return null;
		}

		$intervals = [];
		$start = find_period_start($periods, $time_from);

		while ($start < $time_to && $start > 0) {
			$end = find_period_end($periods, $start, $time_to);
			$intervals[] = [$start, $end];
			$start = find_period_start($periods, $end);
		}

		return $intervals;
	}

	private function respond(array $data): void {
		$this->setResponse(
			(new CControllerResponseData(['main_block' => json_encode($data, JSON_THROW_ON_ERROR)]))->disableView()
		);
	}
}
