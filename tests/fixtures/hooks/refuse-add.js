/* cart:before_add: nothing may be bought in a quantity above 3. */
export default ({ draft }) => {
  if(draft.quantity > 3) throw { code: 409, msg: 'At most 3 of anything' };
};
