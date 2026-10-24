#!/bin/sh
# Install the Enhanced graph theme module into a Zabbix 7.4 frontend.
#
#   ./install.sh                  -> installs into /usr/share/zabbix/ui/modules/enhancedgraph
#   ./install.sh /path/to/ui      -> custom frontend root
#
# Afterwards: Administration -> General -> Modules -> Scan directory -> enable "Enhanced graph theme".
# To switch it off again: disable the module there (graphs go back to classic immediately).

set -e

UI_ROOT="${1:-/usr/share/zabbix/ui}"
SRC="$(cd "$(dirname "$0")" && pwd)/enhancedgraph"
DST="$UI_ROOT/modules/enhancedgraph"

if [ ! -f "$UI_ROOT/zabbix.php" ]; then
	echo "Zabbix frontend not found in $UI_ROOT" >&2
	exit 1
fi

mkdir -p "$UI_ROOT/modules"

if [ -d "$DST" ]; then
	BAK="$DST.bak-$(date +%Y%m%d-%H%M%S)"
	mv "$DST" "$BAK"
	echo "previous version moved to $BAK"
fi

cp -r "$SRC" "$DST"
find "$DST" -type d -exec chmod 755 {} +
find "$DST" -type f -exec chmod 644 {} +

echo "installed into $DST"
echo "now: Administration -> General -> Modules -> Scan directory -> enable 'Enhanced graph theme'"
