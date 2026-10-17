// Checkout payment window and order receipts.
// The server creates the order and decides the mode: 'razorpay' (live keys in server/.env) or 'test' (development only).
// After paying, the proof is sent back to the server, which checks Razorpay's signature before confirming the order.
(() => {
  const C = window.NK_CONFIG || {};
  const live = !!(C.live && C.live.pay);
  const money = n => '₹' + Math.round(n).toLocaleString('en-IN');
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
  const loadScript = src => new Promise((ok, fail) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement('script'); s.src = src; s.onload = ok;
    s.onerror = () => fail(new Error('The payment service could not be reached. Check your connection and try again.'));
    document.head.append(s);
  });

  // Resolves with the proof to send to the server. Rejects {cancelled: true} when the window is closed, or an Error when it fails.
  async function pay({payment, amount, method, name, email, phone, orderRef}) {
    if (payment.mode !== 'razorpay') return testGateway({amount, method, orderRef});
    await loadScript('https://checkout.razorpay.com/v1/checkout.js');
    return new Promise((resolve, reject) => {
      const rzp = new window.Razorpay({
        key: payment.key, order_id: payment.orderId, amount: payment.amount, currency: 'INR',
        name: 'Neelkora', description: `Order ${orderRef}`,
        prefill: {name, email, contact: phone, method: method === 'UPI' ? 'upi' : 'card'},
        notes: {order_ref: orderRef}, theme: {color: '#7A1E2C'},
        handler: r => resolve({razorpay_payment_id: r.razorpay_payment_id, razorpay_order_id: r.razorpay_order_id, razorpay_signature: r.razorpay_signature}),
        modal: {ondismiss: () => reject({cancelled: true})},
      });
      rzp.on('payment.failed', r => reject(new Error(((r.error && r.error.description) || 'The payment was declined.') + ' Try again or choose another payment method.')));
      rzp.open();
    });
  }

  // development only: looks like a gateway step, asks for no card or UPI details, moves no money
  function testGateway({amount, method, orderRef}) {
    return new Promise((resolve, reject) => {
      const d = document.createElement('dialog');
      d.className = 'paysheet';
      d.innerHTML = `
        <div class="ps-head"><span class="ps-lock" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></span>
          <div><b>Test payment</b><small>Neelkora, order ${esc(orderRef)}</small></div>
          <button type="button" class="x" data-ps="cancel">Cancel</button></div>
        <div class="ps-body">
          <p class="ps-amt">${money(amount)}</p>
          <p class="ps-method">${method === 'UPI' ? 'UPI' : 'Credit or debit card'}</p>
          <p class="ps-note">Development server: no money moves and no payment details are asked for. Add Razorpay keys to server/.env to take real payments.</p>
          <button type="button" class="btn dark wide" data-ps="ok">Approve test payment</button>
          <button type="button" class="link" data-ps="fail">Simulate a declined payment</button>
        </div>
        <div class="ps-busy" hidden><span class="spinner" aria-hidden="true"></span><p>Processing payment…</p></div>`;
      document.body.append(d);
      d.showModal();
      const done = fn => { d.close(); d.remove(); fn(); };
      d.addEventListener('cancel', e => { e.preventDefault(); done(() => reject({cancelled: true})); });   // Esc key
      d.addEventListener('click', e => {
        const a = e.target.closest('[data-ps]')?.dataset.ps; if (!a) return;
        if (a === 'cancel') return done(() => reject({cancelled: true}));
        d.querySelector('.ps-body').hidden = true; d.querySelector('.ps-busy').hidden = false;
        setTimeout(() => done(a === 'ok' ? () => resolve({test: true})
          : () => reject(new Error('The test payment was declined. Nothing was charged. Try again or choose another payment method.'))), 1200);
      });
    });
  }

  // the receipt is the exact email the server sends, loaded from the server
  function previewReceipt(o) {
    const d = document.createElement('dialog');
    d.className = 'paysheet mail';
    d.innerHTML = `<div class="ps-head"><div><b>Order email</b><small>To ${esc(o.email)}</small></div><button type="button" class="x">Close</button></div>
      <iframe title="Order confirmation email" sandbox></iframe>`;
    document.body.append(d);
    d.querySelector('iframe').src = `/api/orders/receipt?id=${encodeURIComponent(o.id)}&t=${encodeURIComponent(o.token || '')}`;
    d.showModal();
    d.querySelector('.x').onclick = () => d.close();
    d.addEventListener('close', () => d.remove());
  }

  window.NKPay = {pay, previewReceipt, live};
})();
