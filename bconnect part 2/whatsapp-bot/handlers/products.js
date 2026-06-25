'use strict';
const { sendText, sendGallery, getListingImages, fmtPrice, truncate } = require('../utils');
const { setStep } = require('../state');

const PRODUCT_CATEGORIES = [
  { key: 'Electronics',        label: '📱 Electronics',        subs: [] },
  { key: 'Clothing & Fashion', label: '👗 Clothing & Fashion', subs: [] },
  { key: 'Furniture',          label: '🛋️ Furniture & Home',  subs: [] },
  { key: 'Food & Groceries',   label: '🥦 Food & Groceries',  subs: [] },
  { key: 'Home & Garden',      label: '🏡 Home & Garden',     subs: [] },
  { key: 'Beauty & Health',    label: '💄 Beauty & Health',   subs: [] },
  { key: 'Sports & Fitness',   label: '⚽ Sports & Fitness',  subs: [] },
  { key: 'Baby & Kids',        label: '🍼 Baby & Kids',       subs: [] },
  { key: '',                   label: '🔍 Search by Name',    subs: [] },
];

const PRODUCT_PRICE_RANGES = [
  { label: '💚 Under KSh 1,000',          min: 0,      max: 999 },
  { label: '💛 KSh 1,000 – 5,000',        min: 1000,   max: 5000 },
  { label: '🧡 KSh 5,000 – 20,000',       min: 5000,   max: 20000 },
  { label: '🔴 KSh 20,000 – 100,000',     min: 20000,  max: 100000 },
  { label: '💎 Over KSh 100,000',         min: 100000, max: null },
  { label: '🔓 Any price',                min: null,   max: null },
];

async function showProductsMenu(sock, jid, session) {
  setStep(jid, 'products_cat');
  let msg = '🛍️ *Products Marketplace*\n_Pick a category to see all items:_\n\n';
  PRODUCT_CATEGORIES.forEach((c, i) => { msg += `*${i + 1}.* ${c.label}\n`; });
  msg += '\n_Or *type* a product name to search directly._\n0️⃣  🏠 Main Menu';
  await sendText(sock, jid, msg);
}

async function showProductSubcategories(sock, jid, cat, session) {
  if (!cat.subs || cat.subs.length === 0) {
    return await showProductPriceMenu(sock, jid, cat.key, session);
  }
  setStep(jid, 'products_subcat', { selectedCategory: cat });
  let msg = `${cat.label}\n\nChoose a subcategory to see available items:\n\n`;
  cat.subs.forEach((s, i) => { msg += `${i + 1}. ${s.label}\n`; });
  msg += `\nOr *type* what you're looking for.\n0 - 🔙 Back to Categories`;
  await sendText(sock, jid, msg);
}

async function showProductPriceMenu(sock, jid, query, session) {
  setStep(jid, 'products_price', { pendingProductQuery: query });
  let msg = '💰 *What\'s your budget?*\n\n';
  PRODUCT_PRICE_RANGES.forEach((r, i) => { msg += `${i + 1}. ${r.label}\n`; });
  msg += '\n0 - 🔙 Back';
  await sendText(sock, jid, msg);
}

async function searchProducts(sock, jid, query, session, db, minPrice = null, maxPrice = null, displayLabel = null, exactCategory = false) {
  await sendText(sock, jid, '🔍 _Searching products..._');
  try {
    let results = [];
    if (db) {
      // Base filter: exclude services and housing; accept active OR items with no active field
      const baseFilter = {
        $and: [
          { $or: [{ active: true }, { active: { $exists: false } }, { status: 'approved' }, { status: 'active' }] },
          { listing_type: { $nin: ['service', 'housing'] } },
          { category: { $not: /^service/i } },
          { category: { $not: /^housing/i } },
          { category: { $not: /rental/i } },
        ]
      };

      if (query) {
        if (exactCategory) {
          // Category menu selection: match ONLY the subcategory field exactly
          baseFilter.$and.push({ subcategory: { $regex: `^${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
        } else {
          // Free-text search: match across title, name, description etc.
          baseFilter.$and.push({
            $or: [
              { title: { $regex: query, $options: 'i' } },
              { name: { $regex: query, $options: 'i' } },
              { subcategory: { $regex: query, $options: 'i' } },
              { tags: { $regex: query, $options: 'i' } },
              { description: { $regex: query, $options: 'i' } },
            ]
          });
        }
      }

      if (minPrice !== null || maxPrice !== null) {
        const priceFilter = {};
        if (minPrice !== null) priceFilter.$gte = minPrice;
        if (maxPrice !== null) priceFilter.$lte = maxPrice;
        baseFilter.$and.push({ $or: [{ price: priceFilter }, { rent: priceFilter }] });
      }

      results = await db.collection('properties').find(baseFilter).sort({ created_at: -1 }).limit(50).toArray();
      console.log(`[Bot] searchProducts query="${query}" found=${results.length}`);
    } else {
      console.log('[Bot] searchProducts: no DB connection');
    }

    if (!results.length) {
      const budgetLabel = (minPrice !== null || maxPrice !== null) ? ' in this price range' : '';
      await sendText(sock, jid,
        `😕 *No items found${budgetLabel}.*\n\n` +
        `_Try a different search word, or:_\n` +
        `0️⃣  🔙 Back to Categories\n` +
        `*MENU* — Main Menu`);
      return;
    }

    setStep(jid, 'products_results', {
      productResults: results,
      productQuery: query,
      productLabel: displayLabel || query,
      selectedCategory: (session && session.data && session.data.selectedCategory) || null,
    });

    const header = displayLabel || (query ? query : 'All Products');

    // Build the list — split into chunks of 20 so no single message is too long
    const CHUNK = 20;
    for (let start = 0; start < results.length; start += CHUNK) {
      const chunk = results.slice(start, start + CHUNK);
      const isFirst = start === 0;
      const isLast  = start + CHUNK >= results.length;

      let msg = '';
      if (isFirst) {
        msg += `🛍️ *${header}*\n`;
        msg += `_${results.length} item(s) — reply a number to read more:_\n`;
        msg += `━━━━━━━━━━━━━━━━━\n`;
      }

      chunk.forEach((p, j) => {
        const idx   = start + j + 1;
        const price = fmtPrice(p.price || p.rent || 0);
        const loc   = p.location ? ` · ${p.location}` : '';
        msg += `${idx}. ${truncate(p.title || p.name, 40)} — _${price}${loc}_\n`;
      });

      if (isLast) {
        msg += `\n━━━━━━━━━━━━━━━━━\n`;
        msg += `0️⃣  🔙 Back  |  *MENU* Home`;
      }

      await sendText(sock, jid, msg);
    }

  } catch (e) {
    console.error('[Bot products error]', e.message);
    await sendText(sock, jid, '❌ Error searching products. Type MENU to try again.');
  }
}

async function showProductDetail(sock, jid, product, session) {
  const imgs = getListingImages(product);
  setStep(jid, 'product_detail', { selectedProduct: product, galleryImages: imgs });
  const price = fmtPrice(product.price || product.rent || 0);

  const detail =
    `🛍️ *${product.title || product.name}*\n\n` +
    `💰 *Price:* ${price}\n` +
    `📍 *Location:* ${product.location || 'Kenya'}\n` +
    `📦 *Category:* ${product.category || 'General'}\n` +
    `\n${truncate(product.description, 200)}\n\n` +
    `Reply:\n1 - 💳 Buy Now\n2 - 💬 Chat Seller\n3 - 🔙 Back to Results\n4 - 🏠 Main Menu` +
    (imgs.length > 1 ? `\n5 - 📸 More Photos (${imgs.length} photos)` : '');

  await sendGallery(sock, jid, imgs, detail);
}

async function createListingPrompt(sock, jid, session) {
  setStep(jid, 'create_photo');
  await sendText(sock, jid,
    '📸 *Create a Listing*\n\nStep 1 of 4: Send a *photo* of your product.\n\nType *CANCEL* to stop.');
}

module.exports = {
  searchProducts, showProductDetail, showProductsMenu,
  showProductSubcategories, showProductPriceMenu,
  createListingPrompt, PRODUCT_CATEGORIES, PRODUCT_PRICE_RANGES,
};
