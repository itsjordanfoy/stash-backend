require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), override: true });
const { isSameProduct } = require('../services/scraperService');

const tests = [
  // Leica — should ONLY match exact model
  { name: 'Leica Q3', brand: 'Leica', title: 'Leica Q3 Digital Camera', expect: true },
  { name: 'Leica Q3', brand: 'Leica', title: 'Leica Q3 43 Digital Camera', expect: true },
  { name: 'Leica Q3', brand: 'Leica', title: 'Leica Q2 Reporter Digital Camera', expect: false },
  { name: 'Leica Q3', brand: 'Leica', title: 'Leica M11-P Digital Rangefinder', expect: false },
  { name: 'Leica Q3', brand: 'Leica', title: 'Leica CL Mirrorless Digital Camera', expect: false },
  // Hisense model code
  { name: 'Hisense PureFlat RF540N4WFE Fridge Freezer', brand: 'Hisense', title: 'Hisense RF540N4WFE Fridge Freezer Black', expect: true },
  { name: 'Hisense PureFlat RF540N4WFE Fridge Freezer', brand: 'Hisense', title: 'Hisense RF752N4IFE American Fridge Freezer', expect: false },
  // Keyword-only (no model code)
  { name: 'Long Sleeve Rally Tee', brand: 'Aimé Leon Dore', title: 'Long Sleeve Rally Tee by Aime Leon Dore', expect: true },
  { name: 'Long Sleeve Rally Tee', brand: 'Aimé Leon Dore', title: 'John Lewis Organic Cotton Long Sleeve Crew Neck T-Shirt', expect: false },
  // MacBook Neo
  { name: 'MacBook Neo', brand: 'Apple', title: 'Apple MacBook Neo 13-inch', expect: true },
  { name: 'MacBook Neo', brand: 'Apple', title: 'Apple MacBook Pro 14-inch M4', expect: false },
];

let passed = 0;
tests.forEach(t => {
  const result = isSameProduct(t.name, t.brand, t.title);
  const ok = result === t.expect;
  console.log(`${ok ? '✓' : '✗'} [${t.expect ? 'MATCH' : 'REJECT'}] "${t.name}" vs "${t.title.slice(0, 50)}" → ${result}`);
  if (ok) passed++;
});
console.log(`\n${passed}/${tests.length} tests passed`);
process.exit(passed === tests.length ? 0 : 1);
