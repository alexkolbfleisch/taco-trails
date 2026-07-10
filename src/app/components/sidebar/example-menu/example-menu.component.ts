import { Component, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatButtonModule } from '@angular/material/button';
import { TranslateModule } from '@ngx-translate/core';
import { PetriNetLoaderService } from '../../../services/petri-net-loader.service';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
    selector: 'app-example-menu',
    standalone: true,
    imports: [MatIconModule, MatMenuModule, MatButtonModule, TranslateModule, MatTooltipModule],
    templateUrl: './example-menu.component.html',
    styleUrl: './example-menu.component.css',
})
export class ExampleMenuComponent {
    private _petriNetLoaderService = inject(PetriNetLoaderService);

    activeMenu: string | null = null;

    loadExampleFromCategory(category: string, filename: string) {
        const url = `assets/examples/${category}/${filename}`;
        this._petriNetLoaderService.loadFileFromUrl(url);
    }

    loadExample(filename: string) {
        const url = `assets/examples/${filename}`;
        this._petriNetLoaderService.loadFileFromUrl(url);
    }

    setActiveMenu(menu: string | null) {
        this.activeMenu = menu;
    }

    getFolderIcon(menuName: string): string {
        return this.activeMenu === menuName ? 'folder_open' : 'folder';
    }
}
