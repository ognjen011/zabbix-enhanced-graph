# Enhanced graph theme for Zabbix 7.4

A Zabbix frontend module that redraws the **standard Zabbix graphs** with a clean, modern look.
Enable it and the graphs change; disable it and they are back to classic. Nothing else is modified.

Applies to:
- Monitoring → Hosts → Graphs (and Monitoring → Graphs)
- Latest data → Graph (simple item graphs)
- Classic "Graph (classic)" widgets on dashboards

What stays exactly the same (the classic image is still there, invisible, underneath):
- the time selector, drag-to-zoom, double-click zoom out, auto refresh, graph links
- permissions (data is read through the Zabbix API as the logged-in user)

Not drawn: percentile lines. Pie / exploded graphs stay classic.

## Requirements

Zabbix 7.4 frontend (tested on 7.4.16).

## Safety

- Read-only: the module only uses API `get` calls, the same history/trend aggregation as the built-in graphs and the
  same read-only trigger lookup as the classic graph. It never writes to history, trends, items, hosts or dashboards.
- Graph data loads in parallel with the classic image; if anything goes wrong for a graph, that graph stays classic
  (and any classic image not replaced within 10 seconds is shown again).
- No Zabbix core file is changed; everything lives in `modules/enhancedgraph/`.

## Install

**Option 1 - install script**

```sh
scp -r zabbix-enhanced-graph root@<zabbix-server>:/root/
ssh root@<zabbix-server> 'sh /root/zabbix-enhanced-graph/install.sh'
```

`install.sh` installs into `/usr/share/zabbix/ui/modules/enhancedgraph` (Zabbix 7.4 packages). If your frontend lives
elsewhere, pass its path: `sh install.sh /var/www/html/zabbix`. An existing copy is moved aside first.

**Option 2 - manual copy**

```sh
cp -r enhancedgraph /usr/share/zabbix/ui/modules/
chown -R root:root /usr/share/zabbix/ui/modules/enhancedgraph
chmod -R u=rwX,go=rX /usr/share/zabbix/ui/modules/enhancedgraph
```

**Then enable it:** Administration → General → Modules → **Scan directory**, and enable **Enhanced graph theme**.
Reload the graph pages once (Ctrl/Cmd+R).

## Switch off / remove

- Off for everybody: disable the module in Administration → General → Modules (graphs are classic immediately).
- Off for yourself only: click "Classic graph" on any graph.
- Remove completely: disable it, delete it from the Modules list, then
  `rm -r /usr/share/zabbix/ui/modules/enhancedgraph`.

## Preview without Zabbix

- `preview.html` - dashboard-style preview with a Zabbix-like time selector (sample data).
- `test/mock-zabbix.html` - mock Zabbix graph page: the module script finds the (fake) classic graph images and draws
  over them exactly as in Zabbix (traffic with trigger line, ICMP min/max band, stacked CPU, memory).

## Files

```
enhancedgraph/
  manifest.json                        module definition (type: module)
  actions/GraphData.php                read-only JSON data for one graph
  assets/js/class.enhancedgraph.js     graph renderer (also used by the preview pages)
  assets/js/enhancedgraph.theme.js     finds classic graph images and draws over them
  assets/css/enhancedgraph.css         overlay styles
install.sh                             installer
preview.html                           dashboard-style preview with sample data
test/mock-zabbix.html                  mock Zabbix graph page with sample data
test/chart.php, test/chart2.php        blank images used by the mock page (stand-ins for the Zabbix graph PNGs)
```

## License

MIT - see [LICENSE](LICENSE). Copyright (c) 2026 Ognjen Sijan.
