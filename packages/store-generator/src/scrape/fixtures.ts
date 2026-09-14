/**
 * Hand-built fixtures mirroring the page shapes we support. These stand in for
 * real AliExpress HTML in tests so the suite never depends on the network or on
 * whatever markup AliExpress is serving today.
 */

export const RUN_PARAMS_HTML = `<!doctype html>
<html><head><title>Wireless Earbuds</title></head>
<body>
<script>
window.runParams = {
  "data": {
    "titleComponent": { "subject": "Wireless Earbuds Pro ANC" },
    "imageComponent": {
      "imagePathList": [
        "//ae01.alicdn.com/kf/one.jpg_640x640q90.jpg",
        "//ae01.alicdn.com/kf/two.jpg",
        "//ae01.alicdn.com/kf/one.jpg_640x640q90.jpg"
      ]
    },
    "priceComponent": {
      "discountPrice": { "minActivityAmount": { "value": 18.99, "currency": "USD" } },
      "origPrice": { "minAmount": { "value": 39.99, "currency": "USD" } }
    },
    "feedbackComponent": { "evarageStar": 4.7, "totalValidNum": 2841 },
    "shippingComponent": { "shipFromCountryFullName": "China" },
    "skuComponent": {
      "productSKUPropertyList": [
        {
          "skuPropertyId": 14,
          "skuPropertyName": "Color",
          "skuPropertyValues": [
            { "propertyValueId": 350, "propertyValueDisplayName": "Black" },
            { "propertyValueId": 351, "propertyValueDisplayName": "White" }
          ]
        }
      ]
    },
    "priceComponent2": {},
    "skuModule": {
      "skuPriceList": [
        {
          "skuId": "12001",
          "skuPropIds": "14:350",
          "skuAttr": "14:350#Black",
          "skuVal": { "skuActivityAmount": { "value": 18.99 }, "availQuantity": 120 }
        },
        {
          "skuId": "12002",
          "skuPropIds": "14:351",
          "skuAttr": "14:351#White",
          "skuVal": { "skuActivityAmount": { "value": 21.5 }, "availQuantity": 0 }
        }
      ]
    }
  }
};
</script>
</body></html>`;

export const JSON_LD_HTML = `<!doctype html>
<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "Stainless Steel Water Bottle",
  "description": "<p>Keeps drinks cold for 24 hours.</p>",
  "image": ["https://ae01.alicdn.com/kf/bottle.jpg"],
  "offers": { "@type": "Offer", "price": "14.50", "priceCurrency": "EUR" },
  "aggregateRating": { "ratingValue": 4.4, "reviewCount": 189 }
}
</script>
<script type="application/ld+json">{ not valid json </script>
</head><body></body></html>`;

export const OPEN_GRAPH_HTML = `<!doctype html>
<html><head>
<title>Fallback Product | AliExpress</title>
<meta property="og:title" content="Folding Camp Chair &amp; Bag" />
<meta property="og:description" content="Lightweight and packable." />
<meta property="og:image" content="//ae01.alicdn.com/kf/chair.jpg" />
<meta property="product:price:amount" content="27.00" />
<meta property="product:price:currency" content="GBP" />
</head><body></body></html>`;

/** A page that parsed fine but carried no price — a real failure mode. */
export const NO_PRICE_HTML = `<!doctype html>
<html><head>
<meta property="og:title" content="Mystery Item" />
</head><body></body></html>`;

export const EMPTY_HTML = `<!doctype html><html><body>Blocked</body></html>`;
