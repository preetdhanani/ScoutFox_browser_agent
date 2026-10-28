/*
 * The rows of virtual-list.html: 500 orders, one of them far down the list from "Zanzibar Spice
 * Co.". Plain script: the page loads it with <script src>, and the mock's self-test runs the same
 * file, so the page and the walk can never disagree about a row.
 */
(function (root) {
  const CUSTOMERS = ['Alba Moreno', 'Bergstrom Tools', 'Chen Lighting', 'Dalia Okafor', 'Eriksen Bakery', 'Fjord Outfitters', 'Gupta and Sons',
    'Hollis Print Shop', 'Ivana Petrova', 'Juniper Cafe', 'Kowalski Garage', 'Lumen Studio', 'Marisol Duarte', 'Nakamura Textiles',
    'Oakridge School', 'Pereira Imports', 'Quill and Ink', 'Rossi Pasta', 'Sato Ceramics', 'Tamsin Hale', 'Umbra Design', 'Vargas Logistics', 'Willow Florist'];
  const CITIES = ['Lisbon', 'Oslo', 'Taipei', 'Lagos', 'Aarhus', 'Bergen', 'Pune', 'Leeds', 'Sofia', 'Austin', 'Gdansk', 'Lyon', 'Quito', 'Osaka', 'Denver', 'Porto', 'Graz'];
  const STATUSES = ['shipped', 'paid, waiting to ship', 'delivered', 'on hold: address check', 'shipped', 'delivered', 'cancelled by customer'];
  /** The row the virtual-scroll task looks for, by its index (0-based). */
  const TARGET_INDEX = 96;
  const rows = [];
  for (let i = 0; i < 500; i++) {
    const order = 41000 + i;
    rows.push(i === TARGET_INDEX
      ? { order, customer: 'Zanzibar Spice Co.', city: 'Stone Town', status: 'refund approved' }
      : { order, customer: CUSTOMERS[(i * 5) % CUSTOMERS.length], city: CITIES[(i * 3) % CITIES.length], status: STATUSES[i % STATUSES.length] });
  }
  /** One row as the page writes it. */
  const rowText = (r) => `Order ${r.order} - ${r.customer} - ${r.city} - ${r.status}`;
  root.VIRTUAL_ORDERS = { rows, rowText, TARGET_INDEX };
})(typeof window !== 'undefined' ? window : globalThis);
