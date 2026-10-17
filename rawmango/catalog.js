// Products and pricing, shared by the browser (window.NK_CATALOG) and the server (require('./catalog.js')).
// The server always re-prices orders from this file, so a changed price in the browser cannot change what is charged.
(function (root) {
  // Photos live in img/products: <name>-front|pallu|back-700.webp for cards, -1200.webp for the product page.
  const pic = (c, view) => `img/products/${c}-${view}-700.webp`;
  const P = (id, name, weave, occasion, price, colour, c, about) =>
    ({id, name, weave, occasion, price, colour, img: pic(c, 'front'), alt: pic(c, 'pallu'), back: pic(c, 'back'), about});

  const products = [
    P('sindoor', 'Sindoor', 'Brocade', 'bridal', 86000, 'Sindoor red and gold', 'red',
      'Banarasi brocade in sindoor red, scattered with gold buttis and finished with a heavy zari pallu for the wedding day.'),
    P('samudra', 'Samudra', 'Chanderi', 'festive', 34000, 'Sea green and rani pink', 'sea-green',
      'Sea-green Chanderi silk with silver buttas and a rani pink border that flashes as the pallu moves.'),
    P('kesar', 'Kesar', 'Mashru', 'mehendi', 28500, 'Saffron', 'saffron',
      'Saffron Mashru with a soft tissue sheen and a woven gold pallu, bright enough for a sunlit haldi.'),
    P('neel', 'Neel', 'Chanderi', 'reception', 31000, 'Royal blue', 'royal-blue',
      'Royal-blue Chanderi with silver motifs and a striped pallu that catches the evening light.'),
    P('gulabi', 'Gulabi', 'Chanderi', 'mehendi', 26000, 'Onion pink and yellow', 'onion-pink',
      'Sheer onion-pink Chanderi with gold buttas and a turmeric-yellow border.'),
    P('hariyali', 'Hariyali', 'Brocade', 'bridal', 68000, 'Bottle green and rani pink', 'green-rani',
      'Bottle-green Banarasi with a rani pink pallu worked edge to edge in zari.'),
    P('chandni', 'Chandni', 'Cotton', 'everyday', 14500, 'Ivory and yellow', 'ivory',
      'Ivory cotton silk with gold polka buttas and a bright yellow border, light enough for every day.'),
    P('shaam', 'Shaam', 'Organza', 'reception', 38000, 'Lavender', 'lavender',
      'Lavender organza with a silver zari border, airy and quietly formal.'),
  ];  const occasions = {bridal: 'Bridal', reception: 'Reception', mehendi: 'Mehendi and haldi', festive: 'Festive', everyday: 'Everyday'};
  const get = id => products.find(p => p.id === id);

  const STITCH = 1800, EXPRESS = 500, COD_LIMIT = 50000, MAX_QTY = 5, COUPONS = {NEELKORA10: .10};
  const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
  const validBlouse = b => b === 'unstitched' || SIZES.some(s => b === 'stitched-' + s);
  const unitPrice = item => get(item.id).price + (item.blouse === 'unstitched' ? 0 : STITCH);
  const totals = (items, coupon = '', express = false) => {
    const subtotal = items.reduce((s, i) => s + unitPrice(i) * i.qty, 0);
    const discount = Math.round(subtotal * (COUPONS[String(coupon || '').trim().toUpperCase()] || 0));
    const shipping = items.length && express ? EXPRESS : 0;
    return {subtotal, discount, shipping, total: subtotal - discount + shipping};
  };
  const blouseLabel = b => b === 'unstitched' ? 'Unstitched blouse piece' : `Stitched blouse, size ${b.split('-')[1]}`;

  // self-check of the money maths
  console.assert(totals([{id: 'chandni', blouse: 'unstitched', qty: 2}], 'neelkora10', true).total === 14500 * 2 * .9 + 500, 'totals: coupon + express');
  console.assert(totals([{id: 'kesar', blouse: 'stitched-M', qty: 1}]).total === 28500 + 1800, 'totals: stitched blouse');

  const catalog = {products, occasions, get, STITCH, EXPRESS, COD_LIMIT, MAX_QTY, COUPONS, SIZES, validBlouse, unitPrice, totals, blouseLabel};
  if (typeof module !== 'undefined' && module.exports) module.exports = catalog; else root.NK_CATALOG = catalog;
})(typeof window !== 'undefined' ? window : globalThis);
