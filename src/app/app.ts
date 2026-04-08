import { Component } from '@angular/core';
import { MahjongBoardComponent } from './components/mahjong-board/mahjong-board.component';

@Component({
  selector: 'app-root',
  imports: [MahjongBoardComponent],
  template: '<mahjong-board></mahjong-board>'
})
export class App {}
