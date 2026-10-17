/* order:email_context: adds a tracking line to every customer email. */
export default ({ context }) => {
  context.tracking = 'TRACK-123';
};
