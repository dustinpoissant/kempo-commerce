/* refund:issued: put things back. */
export default ({ refund }) => {
  (globalThis.fixtureRefunds ||= []).push(refund.id);
};
