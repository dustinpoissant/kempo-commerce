/* order:paid: the moment to do the work. */
export default ({ order }) => {
  (globalThis.fixturePaid ||= []).push(order.id);
};
