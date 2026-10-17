/* refund:before_issue: warns, and blocks a refund of exactly 777. */
export default ({ preview }) => {
  preview.warnings.push('This order has a parcel on its way');
  if(preview.amount === 777) throw { code: 409, msg: 'A refund of 777 is blocked by a fraud rule' };
};
