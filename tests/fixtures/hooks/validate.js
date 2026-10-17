/* checkout:validate: refuses a gift message that is too long. */
export default ({ data, errors }) => {
  if(String(data.giftMessage ?? '').length > 20) errors.push({ field: 'giftMessage', msg: 'Keep the gift message under 20 characters' });
};
