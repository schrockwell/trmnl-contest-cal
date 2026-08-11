// parse WA7BNM contest calendar RSS into { contests: [...] }
// works in both runtimes: default uses transform(), serverless uses run()

var MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    var keys = ['#text', '_', '__text', 'text', '$t', 'value'];
    for (var i = 0; i < keys.length; i++) {
      if (typeof v[keys[i]] === 'string') return v[keys[i]];
    }
  }
  return String(v);
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'");
}

// find <item> entries whether TRMNL hands us parsed XML or a raw XML string
function extractItems(input) {
  var root = input;
  if (root && root.IDX_0 !== undefined) root = root.IDX_0;

  var chan = null;
  if (root && root.rss && root.rss.channel) chan = root.rss.channel;
  else if (root && root.channel) chan = root.channel;

  if (chan && chan.item) {
    var arr = Array.isArray(chan.item) ? chan.item : [chan.item];
    return arr.map(function (i) {
      return { title: textOf(i.title), description: textOf(i.description), link: textOf(i.link) };
    });
  }

  var xml = '';
  if (typeof root === 'string') {
    xml = root;
  } else if (root && typeof root === 'object') {
    var vals = Object.values(root);
    for (var j = 0; j < vals.length; j++) {
      if (typeof vals[j] === 'string' && vals[j].indexOf('<item>') !== -1) {
        xml = vals[j];
        break;
      }
    }
  }

  var items = [];
  if (xml) {
    var re = /<item>([\s\S]*?)<\/item>/g;
    var m;
    while ((m = re.exec(xml))) {
      var block = m[1];
      var t = /<title>([\s\S]*?)<\/title>/.exec(block);
      var d = /<description>([\s\S]*?)<\/description>/.exec(block);
      var l = /<link>([\s\S]*?)<\/link>/.exec(block);
      items.push({
        title: t ? t[1] : '',
        description: d ? d[1] : '',
        link: l ? l[1] : ''
      });
    }
  }
  return items;
}

// RSS dates have no year; pick the candidate year whose timestamp is closest to now
function tsFor(mon, day, hh, mm, nowMs) {
  var y = new Date(nowMs).getUTCFullYear();
  var best = null;
  var bestDiff = Infinity;
  for (var dy = -1; dy <= 1; dy++) {
    var ts = Date.UTC(y + dy, mon, day, hh, mm);
    var diff = Math.abs(ts - nowMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = ts;
    }
  }
  return best;
}

// handles: "0100Z-0159Z, Aug 11" | "0700Z, Aug 12 to 0700Z, Aug 14"
//          "0800Z-0829Z (CW), Aug 11 and 0830Z-0859Z (SSB), Aug 11 and ..."
function parseDesc(desc, nowMs) {
  var segs = desc.split(/\s+and\s+/);
  var startTs = null;
  var endTs = null;

  for (var i = 0; i < segs.length; i++) {
    var seg = segs[i].trim();
    var s = null;
    var e = null;

    var m = seg.match(/^(\d{2})(\d{2})Z(?:\s*\([^)]*\))?,\s*([A-Z][a-z]{2})\.?\s+(\d{1,2})\s+to\s+(\d{2})(\d{2})Z(?:\s*\([^)]*\))?,\s*([A-Z][a-z]{2})\.?\s+(\d{1,2})/);
    if (m && MONTHS[m[3]] !== undefined && MONTHS[m[7]] !== undefined) {
      s = tsFor(MONTHS[m[3]], +m[4], +m[1], +m[2], nowMs);
      e = tsFor(MONTHS[m[7]], +m[8], +m[5], +m[6], nowMs);
    } else {
      m = seg.match(/^(\d{2})(\d{2})Z-(\d{2})(\d{2})Z(?:\s*\([^)]*\))?,\s*([A-Z][a-z]{2})\.?\s+(\d{1,2})/);
      if (m && MONTHS[m[5]] !== undefined) {
        s = tsFor(MONTHS[m[5]], +m[6], +m[1], +m[2], nowMs);
        e = tsFor(MONTHS[m[5]], +m[6], +m[3], +m[4], nowMs);
        if (e < s) e += 86400000; // overnight range, e.g. 2300Z-0100Z
      }
    }

    if (s != null && e != null) {
      if (startTs == null || s < startTs) startTs = s;
      if (endTs == null || e > endTs) endTs = e;
    }
  }

  if (startTs == null || endTs == null) return null;
  return { start: startTs, end: endTs };
}

function hm(d) {
  return ('0' + d.getUTCHours()).slice(-2) + ('0' + d.getUTCMinutes()).slice(-2);
}

function md(d) {
  return MONTH_NAMES[d.getUTCMonth()] + ' ' + d.getUTCDate();
}

function fmtWhen(startMs, endMs) {
  var s = new Date(startMs);
  var e = new Date(endMs);
  var sameDay = s.getUTCFullYear() === e.getUTCFullYear() &&
    s.getUTCMonth() === e.getUTCMonth() &&
    s.getUTCDate() === e.getUTCDate();
  if (sameDay) return md(s) + ' ' + hm(s) + '-' + hm(e) + 'Z';
  return md(s) + ' ' + hm(s) + 'Z - ' + md(e) + ' ' + hm(e) + 'Z';
}

function buildOutput(input) {
  try {
    var nowMs = Date.now();
    var raw = extractItems(input);
    var contests = [];

    for (var i = 0; i < raw.length; i++) {
      var title = decodeEntities(raw[i].title || '').trim();
      var desc = decodeEntities(raw[i].description || '').trim();
      if (!title || !desc) continue;

      var p = parseDesc(desc, nowMs);
      if (!p) continue;

      contests.push({
        title: title,
        when: fmtWhen(p.start, p.end),
        start_ts: Math.floor(p.start / 1000),
        end_ts: Math.floor(p.end / 1000),
        multi_day: (p.end - p.start) >= 86400000
      });
    }

    contests.sort(function (a, b) {
      return a.start_ts - b.start_ts || a.end_ts - b.end_ts;
    });

    return { contests: contests, contest_count: contests.length };
  } catch (err) {
    return { contests: [], contest_count: 0, error: String(err) };
  }
}

function transform(input) {
  return buildOutput(input);
}

function run(input) {
  return buildOutput(input);
}