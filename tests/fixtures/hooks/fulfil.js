/* order:line_fulfillment: a product named Download is delivered at once. */
export default ({ line, fulfillment }) => {
  if(/^Download/.test(line.name)) fulfillment.value = 'none';
};
