import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The controlled shop's storefront: a catalog search with a collapsed filter panel, product pages
 * with option choices, a guest cart and a separate account cart, and a checkout with an order
 * minimum and a shipping address step. It gives search and cart evaluations the shapes real shops
 * have, and every name and value in it is made up.
 */

/** A catalog product. Apparel has option choices; home goods have none. */
export interface StoreProduct {
  readonly id: string;
  readonly name: string;
  readonly department: "home" | "shirts" | "shoes";
  readonly priceMinor: number;
  readonly colors: readonly string[];
  readonly sizes: readonly string[];
  readonly fit: string | undefined;
}

const product = (
  id: string,
  name: string,
  department: StoreProduct["department"],
  priceMinor: number,
  options: { colors?: string[]; sizes?: string[]; fit?: string } = {},
): StoreProduct => ({
  id,
  name,
  department,
  priceMinor,
  colors: options.colors ?? [],
  sizes: options.sizes ?? [],
  fit: options.fit,
});

/** The catalog. A query's size choices depend on what it matches: shirts and shoes differ. */
export const storeProducts: readonly StoreProduct[] = [
  product("p-1", "Brass lamp", "home", 4200),
  product("p-2", "Oak shelf", "home", 9900),
  product("p-3", "Linen shirt", "shirts", 3800, {
    colors: ["White", "Blue"],
    sizes: ["S", "M", "L"],
    fit: "Regular",
  }),
  product("p-4", "Oxford shirt", "shirts", 4500, {
    colors: ["Blue", "Pink"],
    sizes: ["M", "L", "XL"],
    fit: "Slim",
  }),
  product("p-5", "Trail shoe", "shoes", 8900, {
    colors: ["Grey"],
    sizes: ["8", "9", "10", "11"],
    fit: "Regular",
  }),
  product("p-6", "Canvas shoe", "shoes", 5200, {
    colors: ["White"],
    sizes: ["7", "8", "9"],
    fit: "Wide",
  }),
];

/** One cart line: a product, its chosen options, and how many. */
export interface CartLine {
  readonly productId: string;
  readonly color?: string;
  readonly size?: string;
  quantity: number;
}

export interface ShippingAddress {
  readonly name: string;
  readonly street: string;
  readonly city: string;
  readonly postalCode: string;
}

export interface PlacedOrder {
  readonly id: string;
  readonly lines: readonly CartLine[];
  readonly address: ShippingAddress;
  readonly totalMinor: number;
}

/** The storefront's switches and records, part of the shop's state. */
export interface StoreState {
  /** The signed-out browser's cart. It is separate from the account's cart. */
  guestCart: CartLine[];
  /** The account's cart, which a signed-in browser sees. It starts with one line already in it. */
  accountCart: CartLine[];
  /** The subtotal checkout needs before it offers to place the order. */
  orderMinimumMinor: number;
  /** The account's saved shipping address. The account starts with none. */
  savedAddress: ShippingAddress | undefined;
  placedOrders: PlacedOrder[];
}

export const initialStoreState = (): StoreState => ({
  guestCart: [],
  accountCart: [{ productId: "p-1", quantity: 1 }],
  orderMinimumMinor: 5000,
  savedAddress: undefined,
  placedOrders: [],
});

type Route = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

/** What the storefront needs from the shop around it. */
export interface StoreContext {
  readonly state: StoreState;
  readonly signedIn: (request: IncomingMessage) => boolean;
  /** The cookies a page load sets, including the CSRF cookie the forms echo. */
  readonly cookiesFor: (request: IncomingMessage) => string[];
  readonly csrfOf: (request: IncomingMessage) => string | undefined;
}

const escape = (text: string) =>
  text.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );
const money = (minor: number) => `$${(minor / 100).toFixed(2)}`;
const queryOf = (request: IncomingMessage) =>
  new URL(request.url ?? "/", "https://www.shop.test").searchParams;
const readForm = (request: IncomingMessage) =>
  new Promise<URLSearchParams>((resolve, reject) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => resolve(new URLSearchParams(text)));
    request.on("error", reject);
  });
const redirect = (response: ServerResponse, location: string) => {
  response.writeHead(303, { location });
  response.end();
};
const productOf = (id: string | null) => storeProducts.find((item) => item.id === id);
const lineName = (line: CartLine) =>
  [productOf(line.productId)?.name ?? line.productId, line.color, line.size]
    .filter((part) => part !== undefined)
    .join(", ");
const lineKey = (line: Omit<CartLine, "quantity">) =>
  [line.productId, line.color ?? "", line.size ?? ""].join("|");
const subtotalOf = (lines: readonly CartLine[]) =>
  lines.reduce(
    (sum, line) => sum + (productOf(line.productId)?.priceMinor ?? 0) * line.quantity,
    0,
  );

/** Products whose name or department holds every word of the query. */
const matching = (query: string) => {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  return storeProducts.filter((item) =>
    words.every((word) => `${item.name} ${item.department}`.toLowerCase().includes(word)),
  );
};
const filterGroups = [
  { name: "size", label: "Size", values: (item: StoreProduct) => item.sizes },
  { name: "color", label: "Color", values: (item: StoreProduct) => item.colors },
  { name: "fit", label: "Fit", values: (item: StoreProduct) => (item.fit ? [item.fit] : []) },
] as const;

export const storeRoutes = (context: StoreContext): ReadonlyMap<string, Route> => {
  const { state } = context;
  const page = (
    request: IncomingMessage,
    response: ServerResponse,
    title: string,
    body: string,
  ) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": context.cookiesFor(request),
    });
    response.end(
      `<title>${title}</title><nav><a href="/catalog">Shop</a> <a href="/cart">Cart</a> ${context.signedIn(request) ? `<a id="account" href="/account">Account</a>` : `<a href="/login">Sign in</a>`}</nav><main>${body}</main>`,
    );
  };
  const cartOf = (request: IncomingMessage) =>
    context.signedIn(request) ? state.accountCart : state.guestCart;
  const csrfField = (request: IncomingMessage) =>
    `<input type="hidden" name="csrf" value="${escape(context.csrfOf(request) ?? "")}">`;
  // Form posts carry the CSRF cookie's value back, as the shop's script calls do in a header.
  const formPost =
    (route: (request: IncomingMessage, response: ServerResponse, form: URLSearchParams) => void) =>
    async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== "POST") return redirect(response, "/catalog");
      const form = await readForm(request);
      const token = form.get("csrf");
      if (token === null || token !== context.csrfOf(request)) {
        response.writeHead(403, { "content-type": "text/html; charset=utf-8" });
        return void response.end("<title>Forbidden</title><p>Your session expired.</p>");
      }
      route(request, response, form);
    };

  // The search results page. Its filters sit in a panel the "All filters" button opens, the
  // panel offers only the choices the query's results have, each applied filter shows as a chip
  // that removes it, and a search nothing matches says so.
  const catalog: Route = (request, response) => {
    const query = queryOf(request);
    const text = query.get("q") ?? "";
    const results = matching(text);
    const applied = filterGroups.map((group) => ({ ...group, chosen: query.getAll(group.name) }));
    const shown = results.filter((item) =>
      applied.every(
        (group) =>
          group.chosen.length === 0 ||
          group.values(item).some((value) => group.chosen.includes(value)),
      ),
    );
    const without = (name: string, value: string) => {
      const next = new URLSearchParams(query);
      next.delete(name);
      for (const kept of query.getAll(name)) if (kept !== value) next.append(name, kept);
      return `/catalog?${next.toString()}`;
    };
    const chips = applied.flatMap((group) =>
      group.chosen.map(
        (value) =>
          `<a class="chip" href="${escape(without(group.name, value))}" aria-label="Remove ${group.label} ${escape(value)}">${group.label}: ${escape(value)} ×</a>`,
      ),
    );
    const panel = applied
      .map((group) => {
        const offered = [...new Set(results.flatMap((item) => group.values(item)))];
        if (offered.length === 0) return "";
        return `<fieldset><legend>${group.label}</legend>${offered
          .map(
            (value) =>
              `<label><input type="checkbox" name="${group.name}" value="${escape(value)}"${group.chosen.includes(value) ? " checked" : ""}> ${escape(value)}</label>`,
          )
          .join("")}</fieldset>`;
      })
      .join("");
    const list =
      shown.length === 0
        ? `<p id="no-results">No products match your search. Try removing a filter.</p>`
        : `<p id="count">${shown.length} ${shown.length === 1 ? "result" : "results"}</p><ul id="results">${shown
            .map(
              (item) =>
                `<li data-id="${item.id}"><a href="/product?id=${item.id}">${item.name}</a> <span class="price">${money(item.priceMinor)}</span>${item.sizes.length > 0 ? ` <span class="sizes">Sizes ${item.sizes.join(", ")}</span>` : ""}</li>`,
            )
            .join("")}</ul>`;
    page(
      request,
      response,
      "Search",
      `<form action="/catalog"><input name="q" value="${escape(text)}" aria-label="Search"><button>Search</button></form>
<button id="all-filters" type="button" aria-expanded="false" aria-controls="filters">All filters</button>
<form id="filters" action="/catalog" hidden><input type="hidden" name="q" value="${escape(text)}">${panel}<button>Show results</button></form>
${chips.length > 0 ? `<div id="applied">${chips.join(" ")} <a href="/catalog?q=${encodeURIComponent(text)}">Clear all</a></div>` : ""}
${list}
<script>document.querySelector('#all-filters').addEventListener('click',event=>{const panel=document.querySelector('#filters');panel.hidden=!panel.hidden;event.target.setAttribute('aria-expanded',String(!panel.hidden))})</script>`,
    );
  };

  // A product page. A product with options asks for each before it goes in the cart.
  const productPage = (
    request: IncomingMessage,
    response: ServerResponse,
    item: StoreProduct,
    problem = "",
  ) => {
    const choice = (name: string, label: string, values: readonly string[]) =>
      values.length === 0
        ? ""
        : `<label>${label}<select name="${name}"><option value="">Choose ${label.toLowerCase()}</option>${values
            .map((value) => `<option>${escape(value)}</option>`)
            .join("")}</select></label>`;
    page(
      request,
      response,
      item.name,
      `<h1>${item.name}</h1><p class="price">${money(item.priceMinor)}</p>${problem ? `<p id="problem" role="alert">${problem}</p>` : ""}
<form method="post" action="/cart/add">${csrfField(request)}<input type="hidden" name="productId" value="${item.id}">${choice("color", "Color", item.colors)}${choice("size", "Size", item.sizes)}<label>Quantity<input name="quantity" type="number" min="1" value="1"></label><button>Add to cart</button></form>`,
    );
  };
  const productRoute: Route = (request, response) => {
    const item = productOf(queryOf(request).get("id"));
    if (item === undefined) return page(request, response, "Not found", "<p>No such product.</p>");
    productPage(request, response, item);
  };

  // Adding a product already in the cart with the same options raises that line's quantity.
  const add = formPost((request, response, form) => {
    const item = productOf(form.get("productId"));
    if (item === undefined) return page(request, response, "Not found", "<p>No such product.</p>");
    const color = form.get("color") || undefined;
    const size = form.get("size") || undefined;
    if (item.colors.length > 0 && (color === undefined || !item.colors.includes(color)))
      return productPage(request, response, item, "Choose a color.");
    if (item.sizes.length > 0 && (size === undefined || !item.sizes.includes(size)))
      return productPage(request, response, item, "Choose a size.");
    const quantity = Math.max(1, Math.floor(Number(form.get("quantity") ?? 1)) || 1);
    const cart = cartOf(request);
    const chosen = { productId: item.id, ...(color ? { color } : {}), ...(size ? { size } : {}) };
    const existing = cart.find((line) => lineKey(line) === lineKey(chosen));
    if (existing) existing.quantity += quantity;
    else cart.push({ ...chosen, quantity });
    redirect(response, "/cart");
  });
  // Setting a line's quantity to 0 removes it.
  const update = formPost((request, response, form) => {
    const cart = cartOf(request);
    const index = cart.findIndex((line) => lineKey(line) === form.get("line"));
    const quantity = Math.floor(Number(form.get("quantity") ?? 0)) || 0;
    if (index >= 0 && quantity <= 0) cart.splice(index, 1);
    else if (index >= 0) cart[index]!.quantity = quantity;
    redirect(response, "/cart");
  });

  const minimumNotice = (lines: readonly CartLine[]) => {
    const short = state.orderMinimumMinor - subtotalOf(lines);
    return short > 0
      ? `<p id="minimum">Orders need a subtotal of at least ${money(state.orderMinimumMinor)}. Add ${money(short)} more to check out.</p>`
      : "";
  };
  const cartPage: Route = (request, response) => {
    const cart = cartOf(request);
    const rows = cart
      .map(
        (line) =>
          `<tr data-line="${escape(lineKey(line))}"><td>${escape(lineName(line))}</td><td>${money(productOf(line.productId)?.priceMinor ?? 0)}</td><td><form method="post" action="/cart/update">${csrfField(request)}<input type="hidden" name="line" value="${escape(lineKey(line))}"><input name="quantity" type="number" min="0" value="${line.quantity}" aria-label="Quantity"><button>Update</button></form></td><td><form method="post" action="/cart/update">${csrfField(request)}<input type="hidden" name="line" value="${escape(lineKey(line))}"><input type="hidden" name="quantity" value="0"><button>Remove</button></form></td></tr>`,
      )
      .join("");
    page(
      request,
      response,
      "Cart",
      `<h1>Cart</h1>${context.signedIn(request) ? "" : `<p id="guest-cart">You are not signed in. This cart stays in this browser; sign in to see your account's cart.</p>`}${
        cart.length === 0
          ? `<p id="empty-cart">Your cart is empty.</p>`
          : `<table id="lines"><tr><th>Item</th><th>Price</th><th>Quantity</th><th></th></tr>${rows}</table><p id="subtotal">Subtotal ${money(subtotalOf(cart))}</p>${minimumNotice(cart)}<a href="/checkout">Check out</a>`
      }`,
    );
  };

  // Checkout needs the account. It holds back an order under the minimum, and asks for a shipping
  // address when the account has none saved.
  const checkout: Route = (request, response) => {
    if (!context.signedIn(request))
      return page(
        request,
        response,
        "Checkout",
        `<p id="sign-in-required">Sign in to check out.</p><a href="/login">Sign in</a>`,
      );
    const cart = state.accountCart;
    if (cart.length === 0)
      return page(request, response, "Checkout", `<p id="empty-cart">Your cart is empty.</p>`);
    const summary = `<ul id="summary">${cart.map((line) => `<li>${escape(lineName(line))} × ${line.quantity}</li>`).join("")}</ul><p id="subtotal">Subtotal ${money(subtotalOf(cart))}</p>`;
    const blocked = minimumNotice(cart);
    if (blocked)
      return page(
        request,
        response,
        "Checkout",
        `${summary}${blocked}<a href="/cart">Back to cart</a>`,
      );
    const address = state.savedAddress;
    if (address === undefined)
      return page(
        request,
        response,
        "Checkout",
        `${summary}<h2>Shipping address</h2><p id="no-address">No saved address on this account.</p><form method="post" action="/checkout/address">${csrfField(request)}<label>Full name<input name="name" required></label><label>Street<input name="street" required></label><label>City<input name="city" required></label><label>Postal code<input name="postalCode" required></label><button>Save and continue</button></form>`,
      );
    page(
      request,
      response,
      "Checkout",
      `${summary}<h2>Ship to</h2><p id="address">${escape(`${address.name}, ${address.street}, ${address.city} ${address.postalCode}`)}</p><p>Payment on delivery.</p><form method="post" action="/checkout/place">${csrfField(request)}<button>Place order</button></form>`,
    );
  };
  const saveAddress = formPost((request, response, form) => {
    if (!context.signedIn(request)) return redirect(response, "/checkout");
    const fields = ["name", "street", "city", "postalCode"].map(
      (name) => form.get(name)?.trim() ?? "",
    );
    const [name = "", street = "", city = "", postalCode = ""] = fields;
    if (fields.some((value) => value === "")) return redirect(response, "/checkout");
    state.savedAddress = { name, street, city, postalCode };
    redirect(response, "/checkout");
  });
  const place = formPost((request, response) => {
    const cart = state.accountCart;
    const address = state.savedAddress;
    const totalMinor = subtotalOf(cart);
    if (
      !context.signedIn(request) ||
      address === undefined ||
      cart.length === 0 ||
      totalMinor < state.orderMinimumMinor
    )
      return redirect(response, "/checkout");
    const order = {
      id: `o-${1001 + state.placedOrders.length}`,
      lines: cart.map((line) => ({ ...line })),
      address,
      totalMinor,
    };
    state.placedOrders.push(order);
    state.accountCart = [];
    page(
      request,
      response,
      "Order placed",
      `<p id="confirmation">Order ${order.id} placed. Total ${money(totalMinor)}.</p>`,
    );
  });

  return new Map<string, Route>([
    ["/catalog", catalog],
    ["/product", productRoute],
    ["/cart", cartPage],
    ["/cart/add", add],
    ["/cart/update", update],
    ["/checkout", checkout],
    ["/checkout/address", saveAddress],
    ["/checkout/place", place],
  ]);
};
