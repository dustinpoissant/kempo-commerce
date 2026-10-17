/* checkout:fields: asks for a gift message. */
export default ({ fields }) => {
  fields.push({ key: 'giftMessage', label: 'Gift message', type: 'text', required: false });
};
