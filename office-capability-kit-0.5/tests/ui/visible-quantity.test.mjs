import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../adapters/standalone-ui/controller.mjs';
import { numericFact } from '../../adapters/standalone-ui/oracle.mjs';

// Neutral, synthetic decoder/DOM-shape controls only. No browser is executed.
const observed = (text, unit = '') => ({ status: 'OBSERVED', text, unit });

test('complete visible quantities accept explicit same-text units and decimal/thousands grammar', () => {
 for (const [text, expected, unit] of [
  ['16 tickets', 16, 'tickets'], ['23.25 hours', 23.25, 'hours'],
  ['0 tickets', 0, 'tickets'], ['  16\n tickets  ', 16, 'tickets'],
  ['1,234 tickets', 1234, 'tickets'], ['12,345.625 hours', 12345.625, 'hours'],
  ['1234567.50 hours', 1234567.5, 'hours'], ['-2.5 minutes', -2.5, 'minutes'],
 ]) assert.equal(numericFact(observed(text), expected, unit).status, 'PASS', text);
 assert.equal(numericFact(observed('16', 'tickets'), 16, 'tickets').status, 'PASS');
 assert.equal(numericFact(observed('1,234.50', 'hours'), 1234.5, 'hours').status, 'PASS');
 assert.equal(numericFact(observed('16 tickets', 'All matching records'), 16, 'tickets').status, 'PASS');
});

test('complete, supported wrong scalars remain known FAIL', () => {
 for (const [text, expected, unit] of [
  ['17 tickets', 16, 'tickets'], ['1,235 tickets', 1234, 'tickets'],
  ['23.50 hours', 23.25, 'hours'], ['0 tickets', 1, 'tickets'],
 ]) assert.equal(numericFact(observed(text), expected, unit).status, 'FAIL', text);
 assert.equal(numericFact(observed('17', 'tickets'), 16, 'tickets').status, 'FAIL');
});

test('unsupported grouping, locale, prefixes and free prose remain UNKNOWN without partial extraction', () => {
 for (const text of [
  '1,23 tickets', '12,34,567 tickets', '1234,567 tickets', '0,123 tickets',
  '1.234,50 tickets', '1 234 tickets', '1\u00a0234 tickets', '01 tickets',
  '+16 tickets', '.5 hours', '16. tickets', '0x10 tickets', '1e3 tickets',
  'Tickets: 16', '16 tickets total', '16 tickets / 2 hours', '16 tickets hours',
  '16 tickets,', '16tickets', 'NaN tickets', 'Infinity hours', '-Infinity hours',
 ]) assert.equal(numericFact(observed(text), 16, 'tickets').status, 'UNKNOWN', text);
});

test('missing, nonstring and nonfinite values cannot coerce to a known zero', () => {
 for (const text of [null, undefined, '', ' ', false, true, 0, [], {}, 'NaN', 'Infinity', '9'.repeat(400)])
  assert.equal(numericFact(observed(text, 'tickets'), 0, 'tickets').status, 'UNKNOWN');
 assert.equal(numericFact({ status: 'UNKNOWN', text: '0 tickets' }, 0, 'tickets').status, 'UNKNOWN');
 for (const expected of [null, undefined, false, '16', NaN, Infinity])
  assert.equal(numericFact(observed('16 tickets'), expected, 'tickets').status, 'UNKNOWN');
});

test('missing, conflicting, hidden or unsupported units remain UNKNOWN', () => {
 for (const quantity of [
  observed('16'), observed('16', 'hours'), observed('16', 'tickets hours'),
  observed('16 tickets', 'hours'), observed('16', null), observed('16', false),
  { ...observed('16 tickets'), text_visible: false },
  { ...observed('16', 'tickets'), unit_visible: false },
 ]) assert.equal(numericFact(quantity, 16, 'tickets').status, 'UNKNOWN');
 for (const unit of [null, undefined, '', 'ticket count', 0])
  assert.equal(numericFact(observed('16 tickets'), 16, unit).status, 'UNKNOWN');
 assert.equal(numericFact(observed('16 ticket'), 16, 'tickets').status, 'UNKNOWN');
 assert.equal(numericFact(observed('1 minutes'), 1 / 60, 'hours').status, 'UNKNOWN');
 assert.equal(numericFact(observed('16 tickets', 'tickets'), 16, 'tickets').status, 'PASS');
});

const defaultStyle = { display: 'inline', visibility: 'visible', opacity: '1' };
const rect = { x: 1, y: 1, width: 120, height: 20 };
function textNode(text, options = {}) {
 return { nodeType: 3, textContent: text, rangeVisible: true, parentElement: null, nextSibling: null, ...options };
}
function element(tagName, childNodes = [], options = {}) {
 const el = {
  nodeType: 1, tagName, childNodes, parentElement: null, nextSibling: null,
  style: { ...defaultStyle, ...options.style }, value: options.value ?? '',
  attrs: { ...options.attrs },
  getAttribute(name) { return this.attrs[name] ?? null; },
  get children() { return this.childNodes.filter(child => child.nodeType === 1); },
  querySelectorAll(selector) {
   assert.equal(selector, '*');
   return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
  },
  contains(other) { return this === other || this.children.some(child => child.contains(other)); },
  checkVisibility: () => options.nativeVisible !== false,
  getBoundingClientRect: () => ({ ...rect, ...options.rect }),
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); },
 };
 childNodes.forEach((child, i) => { child.parentElement = el; child.nextSibling = childNodes[i + 1] || null; });
 return el;
}
async function withDom(run, root = null) {
 const priorStyle = globalThis.getComputedStyle, priorDocument = globalThis.document;
 globalThis.getComputedStyle = el => el.style;
 globalThis.document = {
  getElementById(id) { return [root, ...(root?.querySelectorAll('*') || [])].find(el => el?.attrs.id === id) || null; },
  createRange() {
   let node;
   return {
    selectNodeContents(selected) { node = selected; },
    getClientRects() { return node.rangeVisible ? [{ ...rect, width: node.textContent.length * 6 }] : []; },
   };
  },
 };
 try {
  return await run();
 } finally {
  if (priorStyle === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = priorStyle;
  if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
 }
}
async function field(nodes, spec = { label: 'Neutral quantity' }) {
 return withDom(async () => {
  const page = { getByLabel: () => ({ evaluateAll: callback => callback(nodes) }) };
  return new Controller(page, {}).field(spec);
 });
}
function quantity(text, unitNode = null, options = {}) {
 const output = element('OUTPUT', [textNode(text)], options);
 element('DD', unitNode ? [output, unitNode] : [output]);
 return output;
}

test('field capture accepts rendered same-text, adjacent text and adjacent element quantities', async () => {
 for (const output of [
  quantity('16 tickets'), quantity('16', textNode(' tickets')),
  quantity('16', element('SPAN', [textNode('tickets')])),
 ]) {
  const actual = await field([output]);
  assert.equal(actual.text_visible, true);
  assert.equal(numericFact(actual, 16, 'tickets').status, 'PASS');
 }
 const output = element('OUTPUT', [textNode('23.25')]);
 element('DD', [output, textNode(' \n '), element('SPAN', [textNode('hours')])]);
 const actual = await field([output]);
 assert.equal(actual.unit, 'hours');
 assert.equal(actual.unit_visible, true);
 assert.equal(actual.unit_source, 'VISIBLE_ADJACENT_ELEMENT_TEXT_RANGES');
 assert.equal(numericFact(actual, 23.25, 'hours').status, 'PASS');
 const explained = await field([quantity('16 tickets', element('P', [textNode('All matching records')]))]);
 assert.equal(explained.adjacent_text, 'All matching records');
 assert.equal(explained.unit, '');
 assert.equal(numericFact(explained, 16, 'tickets').status, 'PASS');
});

test('field capture never supplies expected mapping units or binds a global chart scale', async () => {
 const output = quantity('16');
 const actual = await field([output], { label: 'Neutral quantity', unit: 'tickets' });
 assert.equal(actual.unit, '');
 assert.equal(actual.unit_visible, false);
 assert.equal(numericFact(actual, 16, 'tickets').status, 'UNKNOWN');
 const chartCount = quantity('5', element('SPAN', [textNode('Scale: 0–5 tickets')]));
 assert.equal(numericFact(await field([chartCount]), 5, 'tickets').status, 'UNKNOWN');
});

test('hidden value elements, ancestors and unrendered text nodes cannot certify a scalar', async () => {
 for (const output of [
  quantity('16 tickets', null, { style: { display: 'none' } }),
  quantity('16 tickets', null, { nativeVisible: false }),
  quantity('16 tickets', null, { rect: { width: 0 } }),
 ]) assert.equal(numericFact(await field([output]), 16, 'tickets').status, 'UNKNOWN');
 const ancestorHidden = quantity('16 tickets'); ancestorHidden.parentElement.style.opacity = '0';
 assert.equal(numericFact(await field([ancestorHidden]), 16, 'tickets').status, 'UNKNOWN');
 const textNotRendered = quantity('16 tickets'); textNotRendered.childNodes[0].rangeVisible = false;
 const missingText = await field([textNotRendered]);
 assert.equal(missingText.text, ''); assert.equal(missingText.text_visible, false);
 assert.equal(numericFact(missingText, 16, 'tickets').status, 'UNKNOWN');
 const childHidden = element('OUTPUT', [element('SPAN', [textNode('16 tickets')], { style: { visibility: 'hidden' } })]);
 element('DD', [childHidden]);
 assert.equal(numericFact(await field([childHidden]), 16, 'tickets').status, 'UNKNOWN');
});

test('hidden inline or adjacent units require visible text-parent and range evidence', async () => {
 for (const unit of [
  element('SPAN', [textNode('tickets')], { style: { display: 'none' } }),
  element('SPAN', [textNode('tickets')], { style: { visibility: 'hidden' } }),
  element('SPAN', [textNode('tickets')], { style: { opacity: '0' } }),
  element('SPAN', [textNode('tickets')], { nativeVisible: false }),
  textNode(' tickets', { rangeVisible: false }),
 ]) {
  const actual = await field([quantity('16', unit)]);
  assert.equal(actual.unit, ''); assert.equal(actual.unit_visible, false);
  assert.equal(numericFact(actual, 16, 'tickets').status, 'UNKNOWN');
 }
 const inline = element('OUTPUT', [textNode('16 '), element('SPAN', [textNode('tickets')], { style: { visibility: 'hidden' } })]);
 element('DD', [inline]);
 assert.equal(numericFact(await field([inline]), 16, 'tickets').status, 'UNKNOWN');
 const orphan = quantity('16', textNode(' tickets')); orphan.nextSibling.parentElement = null;
 assert.equal(numericFact(await field([orphan]), 16, 'tickets').status, 'UNKNOWN');
});

test('conflicting visible values or units remain UNKNOWN; hidden text is not included', async () => {
 const conflicting = await field([quantity('16 tickets'), quantity('17 tickets')]);
 assert.equal(conflicting.status, 'UNKNOWN');
 assert.equal(numericFact(conflicting, 16, 'tickets').status, 'UNKNOWN');
 assert.equal(numericFact(await field([quantity('16 tickets', textNode(' hours'))]), 16, 'tickets').status, 'UNKNOWN');
 const nested = element('OUTPUT', [textNode('16 tickets'), element('SPAN', [textNode(' 99 hours')], { style: { display: 'none' } })]);
 element('DD', [nested]);
 const actual = await field([nested]);
 assert.equal(actual.text, '16 tickets');
 assert.equal(numericFact(actual, 16, 'tickets').status, 'PASS');
});

const chartMapping = {
 chart_axis: 'height',
 chart_count: { label: '{status} count' },
 chart_plot: { label: '{status} plot' },
 chart_glyph: { label: '{status} plotted count' },
};
function chartFixture({ range = 'Scale: 0–5 tickets', named = true, regionRole = false } = {}) {
 const byLabel = {}, groups = [], members = [];
 for (const status of ['OPEN', 'IN_PROGRESS', 'WAITING']) {
  const count = element('OUTPUT', [textNode('5')]);
  const glyph = element('SPAN'), plot = element('SPAN', [glyph]);
  byLabel[`${status} count`] = [count];
  byLabel[`${status} plot`] = [plot];
  byLabel[`${status} plotted count`] = [glyph];
  members.push({ status, count, plot, glyph });
  groups.push(element('DIV', [count, plot]));
 }
 const axis = element('P', [textNode(range)]);
 const attrs = { ...(named ? { 'aria-label': 'Neutral active status chart' } : {}), ...(regionRole ? { role: 'region' } : {}) };
 const region = element(regionRole ? 'DIV' : 'SECTION', [axis, ...groups], { attrs });
 const root = element('BODY', [region]);
 return { root, region, axis, groups, byLabel, members };
}
function append(parent, child) {
 const last = parent.childNodes.at(-1); if (last) last.nextSibling = child;
 child.parentElement = parent; child.nextSibling = null; parent.childNodes.push(child);
}
async function chartContext(fixture, mapping = chartMapping) {
 return withDom(async () => {
  const page = { getByLabel: name => ({ evaluateAll: (callback, argument) => callback(fixture.byLabel[name] || [], argument) }) };
  return new Controller(page, mapping).chartUnitContext();
 }, fixture.root);
}

test('one visible zero-range label binds mapped chart members in their nearest named region', async () => {
 for (const regionRole of [false, true]) {
  const fixture = chartFixture({ regionRole }), context = await chartContext(fixture);
  assert.equal(context.status, 'OBSERVED'); assert.equal(context.unit, 'tickets');
  assert.equal(context.unit_visible, true);
  assert.equal(context.unit_source, 'VISIBLE_NAMED_CHART_REGION_ZERO_RANGE');
  assert.equal(context.range.text, 'Scale: 0–5 tickets');
  assert.equal(context.range.minimum, 0); assert.equal(context.range.maximum, 5);
  assert.equal(context.region.name, 'Neutral active status chart');
  assert.equal(context.region.name_source, 'aria-label');
  assert.equal(context.members.length, 9);
  assert.equal(new Set(context.members.map(member => member.element_ref)).size, 9);
  for (const status of ['OPEN', 'IN_PROGRESS', 'WAITING'])
   assert.deepEqual(context.members.filter(member => member.status === status).map(member => member.kind), ['count', 'plot', 'glyph']);
  // Unit context does not substitute for independent arithmetic or geometry.
  const scalar = { ...observed('5', context.unit), unit_visible: context.unit_visible };
  assert.equal(numericFact(scalar, 5, 'tickets').status, 'PASS');
  assert.equal(numericFact(scalar, 4, 'tickets').status, 'FAIL');
 }
});

test('nested wrappers of one physical range label are not duplicate axis labels', async () => {
 const fixture = chartFixture();
 const wrapped = element('SPAN', [textNode('Scale: 0–5 tickets')]);
 fixture.axis.childNodes = [wrapped]; wrapped.parentElement = fixture.axis;
 const context = await chartContext(fixture);
 assert.equal(context.status, 'OBSERVED');
 assert.match(context.range.element_ref, /span\[1\]$/);
});

test('a style-visible zero-count glyph can establish membership without certifying geometry', async () => {
 const fixture = chartFixture();
 fixture.members[0].glyph.getBoundingClientRect = () => ({ ...rect, height: 0 });
 const context = await chartContext(fixture);
 assert.equal(context.status, 'OBSERVED');
 assert.equal(context.members.find(member => member.status === 'OPEN' && member.kind === 'glyph').rect.height, 0);
 fixture.members[0].glyph.style.visibility = 'hidden';
 assert.equal((await chartContext(fixture)).status, 'UNKNOWN');
 fixture.members[0].glyph.style.visibility = 'visible'; fixture.members[0].glyph.style.opacity = '0';
 assert.equal((await chartContext(fixture)).status, 'UNKNOWN');
});

test('duplicate, conflicting and unsupported chart ranges remain UNKNOWN', async () => {
 for (const extra of ['Scale: 0–5 tickets', 'Scale: 0–5 hours']) {
  const fixture = chartFixture(); append(fixture.region, element('P', [textNode(extra)]));
  assert.equal((await chartContext(fixture)).status, 'UNKNOWN', extra);
 }
 for (const range of [
  'Scale: 1–5 tickets', 'Scale: 0–0 tickets', 'Scale: 0–5,0 tickets',
  'Scale: 0–1,23 tickets', 'Scale: 0–5 tickets and hours',
  'The chart has 0–5 tickets', 'Scale: 0–5', 'Scale: 0–NaN tickets',
 ]) assert.equal((await chartContext(chartFixture({ range }))).status, 'UNKNOWN', range);
 const grouped = await chartContext(chartFixture({ range: 'Capacity: 0-1,234.50 hours' }));
 assert.equal(grouped.status, 'OBSERVED'); assert.equal(grouped.unit, 'hours');
 assert.equal(grouped.range.maximum, 1234.5);
});

test('chart range labels require visible elements, parents and actual text ranges', async () => {
 for (const hide of [
  fixture => { fixture.axis.style.display = 'none'; },
  fixture => { fixture.axis.style.visibility = 'hidden'; },
  fixture => { fixture.axis.childNodes[0].rangeVisible = false; },
  fixture => { fixture.region.style.opacity = '0'; },
  fixture => { fixture.members[0].count.style.display = 'none'; },
 ]) {
  const fixture = chartFixture(); hide(fixture);
  assert.equal((await chartContext(fixture)).status, 'UNKNOWN');
 }
});

test('chart units cannot be borrowed from unnamed, outer, different or global regions', async () => {
 assert.equal((await chartContext(chartFixture({ named: false }))).status, 'UNKNOWN');
 const innerUnnamed = chartFixture();
 const inner = element('SECTION', [...innerUnnamed.region.childNodes]);
 innerUnnamed.region.childNodes = [inner]; inner.parentElement = innerUnnamed.region;
 assert.equal((await chartContext(innerUnnamed)).status, 'UNKNOWN');
 const crossRegion = chartFixture();
 const other = element('SECTION', [crossRegion.members[0].count], { attrs: { 'aria-label': 'Other chart' } });
 append(crossRegion.root, other);
 assert.equal((await chartContext(crossRegion)).status, 'UNKNOWN');
 const globalRange = chartFixture({ range: '' });
 append(globalRange.root, element('P', [textNode('Scale: 0–5 tickets')]));
 assert.equal((await chartContext(globalRange)).status, 'UNKNOWN');
});

test('visible aria-labelledby region names qualify; hidden name labels do not', async () => {
 const fixture = chartFixture({ named: false });
 const heading = element('H2', [textNode('Neutral chart name')], { attrs: { id: 'neutral-chart-name' } });
 append(fixture.region, heading); fixture.region.attrs['aria-labelledby'] = 'neutral-chart-name';
 const context = await chartContext(fixture);
 assert.equal(context.status, 'OBSERVED');
 assert.equal(context.region.name, 'Neutral chart name');
 assert.equal(context.region.name_source, 'visible-aria-labelledby');
 heading.style.visibility = 'hidden';
 assert.equal((await chartContext(fixture)).status, 'UNKNOWN');
});

test('all nine chart mappings must resolve uniquely and cannot supply expected units', async () => {
 const missing = chartFixture(); delete missing.byLabel['OPEN plot'];
 assert.equal((await chartContext(missing)).status, 'UNKNOWN');
 const ambiguous = chartFixture(); ambiguous.byLabel['OPEN count'].push(ambiguous.members[1].count);
 assert.equal((await chartContext(ambiguous)).status, 'UNKNOWN');
 const reused = chartFixture(); reused.byLabel['OPEN count'] = reused.byLabel['WAITING count'];
 assert.equal((await chartContext(reused)).status, 'UNKNOWN');
 const noAxis = chartFixture({ range: '' });
 const hints = { ...chartMapping, chart_count: { ...chartMapping.chart_count, unit: 'tickets' } };
 assert.equal((await chartContext(noAxis, hints)).status, 'UNKNOWN');
 assert.equal((await chartContext(chartFixture(), { chart_count: chartMapping.chart_count })).status, 'UNKNOWN');
});

test('zero extent exemption applies only to the declared axis, not missing cross-axis extent', async()=>{const fixture=chartFixture();fixture.members[0].glyph.getBoundingClientRect=()=>({...rect,width:0,height:160});assert.equal((await chartContext(fixture)).status,'UNKNOWN');assert.equal((await chartContext(fixture,{...chartMapping,chart_axis:'width'})).status,'OBSERVED');});

import {bindSharedChartUnit} from '../../adapters/standalone-ui/observe.mjs';
test('actual field to shared-range fallback to numeric never overrides visible unsupported adjacent unit tokens',async()=>{
 const context=await chartContext(chartFixture());
 for(const adjacent of ['widgets','Tickets','%','widget(s)']){const actual=await field([quantity('5',element('SPAN',[textNode(adjacent)]))]);assert.equal(actual.adjacent_text,adjacent);assert.equal(actual.adjacent_text_visible,true);assert.equal(numericFact(actual,5,'tickets').status,'UNKNOWN');const bound=bindSharedChartUnit(actual,context);assert.deepEqual(bound,actual);assert.equal(numericFact(bound,5,'tickets').status,'UNKNOWN');}
});
test('actual field fallback binds only actual missing units, preserves known wrong scalars and inline/adjacent conflicts',async()=>{
 const context=await chartContext(chartFixture());const plain=await field([quantity('5')]);assert.equal(numericFact(bindSharedChartUnit(plain,context),5,'tickets').status,'PASS');assert.equal(numericFact(bindSharedChartUnit(await field([quantity('6')]),context),5,'tickets').status,'FAIL');
 for(const actual of [await field([quantity('5 hours')]),await field([quantity('5',element('SPAN',[textNode('hours')]))]),await field([quantity('5',null,{style:{opacity:'0'}})])])assert.equal(numericFact(bindSharedChartUnit(actual,context),5,'tickets').status,'UNKNOWN');
 assert.equal(numericFact(bindSharedChartUnit(plain,{status:'UNKNOWN'}),5,'tickets').status,'UNKNOWN');
});
