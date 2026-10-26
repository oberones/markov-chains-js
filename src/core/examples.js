import { fraction, makeSound } from './music.js';

function build(dictionary, sequence) { return sequence.split(' ').map(id => { const [p,n,d=1] = dictionary[id]; return makeSound(p, fraction(n,d)); }); }

/** Original motifs written for this app. Shared states deliberately have different successors. */
export const examples = [
  {id:'drift',name:'Slow orbit',tag:'AMBIENT',description:'Soft chords. Open space. Nowhere to hurry.',tempo:96,preset:'warm',color:'#b2a2ff',events:build({a:[[48,55,64],2],b:[[52,59,67],2],c:[[50,57,65],2],d:[[55,62,69],1],r:[[],1],e:[[67],1]},'a r b a c r a b d r a e b c a r c d a b r a d c')},
  {id:'bells',name:'Lanterns',tag:'BELLS',description:'Little lights calling to one another.',tempo:108,preset:'glassy',color:'#f6c67a',events:build({a:[[72],1,2],b:[[76],1,2],c:[[79],1],d:[[74,81],1],e:[[84],1,2],r:[[],1,2]},'a b c a r d a c e b a d r c a e c b d a b r a c')},
  {id:'play',name:'Cosmic hop',tag:'PLAYFUL',description:'A curious melody taking the scenic route.',tempo:126,preset:'shimmer',color:'#9be3c9',events:build({a:[[60],1,2],b:[[64],1,2],c:[[67],1,2],d:[[62,69],1],e:[[72],1],r:[[],1,2]},'a b c a d r a c e c a b r d a e b c a d c r a b')},
  {id:'pulse',name:'Night drive',tag:'PULSE',description:'A repeating thought that keeps changing.',tempo:118,preset:'dark',color:'#e99fd5',events:build({a:[[36],1,2],b:[[43],1,2],c:[[48,55],1],d:[[38],1,2],e:[[46,53],1],r:[[],1,2]},'a a b r a c a b d a r e a b a c d r a e b a d a')}
];
