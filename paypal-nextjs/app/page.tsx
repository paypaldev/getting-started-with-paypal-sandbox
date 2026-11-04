import PayPalCheckout from "@/components/PayPalCheckout";

export default function ProductPage() {
  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="mb-2 text-2xl font-bold">Developer Hoodie</h1>
      <p className="mb-1 text-zinc-600">
        The only hoodie with a PayPal logo on the back.
      </p>
      <p className="mb-6 text-xl font-semibold">$9.99</p>
      <div className="mb-6 h-48 w-full rounded bg-zinc-100" />
      <PayPalCheckout />
    </main>
  );
}
